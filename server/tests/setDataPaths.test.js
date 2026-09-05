import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-08-27: server/routes/debug.js's POST /paths relocates the panel's
// own database and secrets. Two real defects found reading it:
//   1. moveFiles defaulted to true (`moveFiles !== false` at the route) --
//      a request naming a new dataDir with no moveFiles key at all silently
//      moved db.json and every *.secret file. The destructive option was
//      the default, not a choice.
//   2. The response says "Restart the application to apply changes" -- so
//      pointing dataDir somewhere that LOOKS fine now but doesn't actually
//      end up with a working database is a lockout discovered on next
//      restart, with no way back in through the app that set it.
//
// setDataPaths() itself had zero test coverage before this file. These
// tests cover the validation and anti-lockout logic added alongside the
// default-flip fix (server/routes/debug.js carries the flip and the
// extraBlockedPaths wiring; this file covers the utility both indirectly
// depend on).
//
// No mocking of paths.js needed: server/tests/vitest.perFileDataDir.setup.mjs
// (wired into every test file via vitest.config.js's setupFiles) gives this
// file its own private, temp dataDir/logsDir/config before paths.js is even
// imported -- setDataPaths() below runs for real, against real temp
// directories, not the developer's or panel's actual data.

const { getDataPaths, setDataPaths } = await import("../utils/paths.js");

function freshDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zcp-setpaths-${label}-`));
}

describe("setDataPaths: path validation", () => {
  it("rejects a relative path instead of silently resolving it against the process's working directory", async () => {
    const result = await setDataPaths({ dataDir: "relative/subdir" }, false);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/absolute/i);
  });

  it("still rejects a path under a blocked system directory (unchanged behavior)", async (ctx) => {
    // Reports an actual SKIP, not a bare `return`: a bare return here still
    // counts as a PASS with zero assertions run, which is exactly what every
    // ubuntu-only CI run of this file produced -- CI never runs it on
    // win32, so this, the sole test of BLOCKED_PREFIXES, silently passed
    // without checking anything (emptying BLOCKED_PREFIXES entirely still
    // gave a green tick), while four codeql[js/path-injection] suppressions
    // elsewhere cite this test as their justification. See the
    // windows-packaged-updater CI job, which now runs this file for real.
    if (process.platform !== "win32") return ctx.skip(); // BLOCKED_PREFIXES is platform-specific
    const result = await setDataPaths({ dataDir: "C:\\Windows\\zcp-test" }, false);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/protected system directory/i);
  });

  it("rejects a target that is INSIDE a caller-supplied extraBlockedPaths entry", async () => {
    const pzInstall = freshDir("pz-install-inside");
    const target = path.join(pzInstall, "Server");
    const result = await setDataPaths(
      { dataDir: target },
      false,
      { extraBlockedPaths: [pzInstall] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/overlaps/i);
  });

  it("rejects a target that CONTAINS a caller-supplied extraBlockedPaths entry (the reverse direction)", async () => {
    const root = freshDir("ancestor-root");
    const pzInstall = path.join(root, "pz", "install");
    fs.mkdirSync(pzInstall, { recursive: true });
    const result = await setDataPaths(
      { dataDir: root },
      false,
      { extraBlockedPaths: [pzInstall] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/overlaps/i);
  });

  it("does not flag an unrelated directory as overlapping", async () => {
    const pzInstall = freshDir("pz-install-unrelated");
    const target = freshDir("unrelated-target");
    const result = await setDataPaths(
      { dataDir: target },
      false,
      { extraBlockedPaths: [pzInstall] },
    );
    expect(result.success).toBe(true);
  });
});

describe("setDataPaths: moveFiles defaults to false", () => {
  it("does NOT copy files when moveFiles is omitted entirely, even though the old dataDir has real content", async () => {
    const oldDir = freshDir("old-data-default");
    fs.writeFileSync(path.join(oldDir, "db.json"), "{}");
    const pin = await setDataPaths({ dataDir: oldDir }, false);
    expect(pin.success).toBe(true);

    const newDir = freshDir("new-data-default");
    const result = await setDataPaths({ dataDir: newDir }); // moveFiles arg omitted
    expect(result.success).toBe(true);
    expect(result.filesMoved.data).toBe(false);
    expect(fs.existsSync(path.join(newDir, "db.json"))).toBe(false);
  });
});

describe("setDataPaths: the happy path really moves the database", () => {
  it("moves db.json to the new location when moveFiles is explicitly true", async () => {
    const oldDir = freshDir("old-data-move");
    fs.writeFileSync(path.join(oldDir, "db.json"), '{"real":true}');
    const pin = await setDataPaths({ dataDir: oldDir }, false);
    expect(pin.success).toBe(true);

    const newDir = freshDir("new-data-move");
    const result = await setDataPaths({ dataDir: newDir }, true);
    expect(result.success).toBe(true);
    expect(result.filesMoved.data).toBe(true);
    expect(fs.readFileSync(path.join(newDir, "db.json"), "utf8")).toBe('{"real":true}');
  });
});

describe("setDataPaths: break-verify the anti-lockout guard against a real, reproducible partial-copy", () => {
  it("aborts BEFORE switching paths if the copy silently leaves db.json behind (e.g. a permissions quirk on that one file)", async () => {
    const oldDir = freshDir("old-data-partial");
    fs.writeFileSync(path.join(oldDir, "db.json"), '{"important":true}');
    const pin = await setDataPaths({ dataDir: oldDir }, false);
    expect(pin.success).toBe(true);
    const pinnedDataDir = getDataPaths().dataDir;

    const newDir = freshDir("new-data-partial");
    const realCopyFileSync = fs.copyFileSync.bind(fs);
    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation((src, dest, ...rest) => {
      // Simulate exactly the silent, no-throw failure mode described in
      // paths.js's own comment: db.json specifically doesn't make it
      // across, everything else (if there were anything else) would.
      if (path.basename(src) === "db.json") return undefined;
      return realCopyFileSync(src, dest, ...rest);
    });

    let result;
    try {
      result = await setDataPaths({ dataDir: newDir }, true);
    } finally {
      copySpy.mockRestore();
    }

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/did not produce a database file/i);
    // The old location is untouched and still the active one -- the config
    // switch (the point of no return) never happened.
    expect(getDataPaths().dataDir).toBe(pinnedDataDir);
    expect(fs.existsSync(path.join(oldDir, "db.json"))).toBe(true);
  });

  it("does NOT false-positive when the source legitimately has no database yet", async () => {
    const oldDir = freshDir("old-data-empty");
    // No db.json written -- a legitimately fresh/empty data directory.
    const pin = await setDataPaths({ dataDir: oldDir }, false);
    expect(pin.success).toBe(true);

    const newDir = freshDir("new-data-empty-target");
    const result = await setDataPaths({ dataDir: newDir }, true);
    expect(result.success).toBe(true);
  });
});
