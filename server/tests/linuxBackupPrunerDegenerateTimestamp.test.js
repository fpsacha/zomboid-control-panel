import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createBackup } from "../utils/configBackup.js";

// 2026-08-29, Linux bug hunt (god, "backups: the pruner still deletes the
// newest backup on Linux"): the pruner fix in 48de518/b8c288f sorted
// existing backups by real fs birthtime instead of the filename string, and
// that held up on Windows -- but on real Linux/ext4 (confirmed here via
// WSL2 Ubuntu, Node v24.19), several backups of the SAME file created
// within one JS tick can get IDENTICAL stats.birthtimeMs. When every
// candidate ties, Array.prototype.sort's stability falls back to the
// original array order -- readdir()'s order, which has no relationship to
// creation order -- and the brand-new backup this very call just created
// can be the one pruned instead of a genuinely older one.
//
// server/tests/configBackup.test.js's "pruning still keeps only the 10
// newest..." test already reproduces this for real on Linux (it seeds 9
// backups back-to-back with no delay, exactly the pattern that ties
// birthtimeMs there) -- see that file. This test pins the same root cause
// WITHOUT depending on real filesystem timing at all, so it stays a
// meaningful regression check on every platform (including Windows, where
// birthtime doesn't tie under this pattern and so never caught the bug in
// the first place): it forces the degenerate case directly by making every
// stat() call return the exact same timestamp, the worst case Linux can
// hand back, and asserts the pruner still gets the ordering right.
describe("createBackup() pruning under a degenerate (all-identical) fs timestamp", () => {
  let root;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the brand-new backup even when every backup on disk reports the identical birthtime", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-configbackup-degenerate-"));
    const iniPath = path.join(root, "servertest.ini");
    const backupDir = path.join(root, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(iniPath, "current", "utf8");

    // 10 pre-existing backups, oldest-to-newest by their OWN embedded
    // timestamp -- this ordering is the only signal the fix is allowed to
    // use. Real Linux ext4 resolution issues would make every one of these
    // report an identical stats.birthtimeMs; force that worst case
    // directly rather than hoping to hit it by timing.
    for (let i = 0; i < 10; i++) {
      const ts = `2026-08-2${i}T00-00-00-000Z`;
      fs.writeFileSync(
        path.join(backupDir, `servertest.ini.${ts}.bak`),
        `seed ${i}`,
        "utf8",
      );
    }

    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, "stat").mockImplementation(async (p) => {
      const real = await realStat(p);
      // Simulate the degenerate case: every file, regardless of when it was
      // actually written, reports the SAME birthtime -- the worst case
      // observed on real Linux/ext4 for files created close together.
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        birthtimeMs: 0,
        birthtime: new Date(0),
      });
    });

    const result = await createBackup(root, "servertest.ini");
    expect(result.backedUp).toBe(true);

    const remaining = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("servertest.ini.") && f.endsWith(".bak"));
    expect(remaining).toHaveLength(10);

    // The brand-new backup must survive pruning regardless of what fs.stat
    // reports for anyone's birthtime.
    expect(remaining).toContain(result.name);
    // And the pruner must still drop the TRUE oldest seed (by its own
    // embedded timestamp), not an arbitrary one picked by readdir order.
    expect(remaining).not.toContain("servertest.ini.2026-08-20T00-00-00-000Z.bak");
    for (let i = 1; i < 10; i++) {
      expect(remaining).toContain(`servertest.ini.2026-08-2${i}T00-00-00-000Z.bak`);
    }
  });
});
