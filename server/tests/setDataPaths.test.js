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

const { getDataPaths, setDataPaths, logsDirRefusal, dataDirRefusal, getPanelProgramDir } = await import("../utils/paths.js");

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

// Security audit 2026-10-20: POST /api/debug/paths accepted the panel's own
// data folder as the logs folder, and GET /logs/download/:filename then
// served jwt.secret and db.json from it. The logs folder can no longer be,
// hold, or sit inside the data folder, the program folder (other than its own
// logs folder) or the folder of a secret file -- as typed or through a link.
describe("setDataPaths: the logs folder stays clear of the panel's secrets", () => {
  it("refuses the data folder itself as the logs folder", async () => {
    const before = getDataPaths().logsDir;
    const result = await setDataPaths({ logsDir: getDataPaths().dataDir }, false);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/data folder/i);
    expect(getDataPaths().logsDir).toBe(before);
  });

  it("refuses a folder inside the data folder, and one that holds it", async () => {
    const { dataDir } = getDataPaths();
    expect((await setDataPaths({ logsDir: path.join(dataDir, "server-secrets") }, false)).success).toBe(false);
    expect((await setDataPaths({ logsDir: path.dirname(dataDir) }, false)).success).toBe(false);
  });

  it("refuses the data folder named in the same request", async () => {
    const dir = freshDir("same-request");
    const result = await setDataPaths({ dataDir: dir, logsDir: path.join(dir, "logs") }, false);
    expect(result.success).toBe(false);
  });

  it("refuses a new data folder that would hold the current logs folder", async () => {
    const result = await setDataPaths({ dataDir: path.dirname(getDataPaths().logsDir) }, false);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/logs folder/i);
  });

  // (A trailing-dot spelling is not an alias here: Node creates "data." as a
  // folder of its own on Windows.)
  it("refuses a case variant of the data folder on Windows", async (ctx) => {
    if (process.platform !== "win32") return ctx.skip();
    const { dataDir } = getDataPaths();
    expect((await setDataPaths({ logsDir: dataDir.toUpperCase() }, false)).success).toBe(false);
  });

  it("refuses a junction (or symlink) to the data folder, and a folder below one", async () => {
    const holder = freshDir("junction-holder");
    const link = path.join(holder, "alias");
    fs.symlinkSync(getDataPaths().dataDir, link, "junction");
    expect((await setDataPaths({ logsDir: link }, false)).success).toBe(false);
    expect((await setDataPaths({ logsDir: path.join(link, "not-yet-created") }, false)).success).toBe(false);
  });

  it("refuses a logs folder holding a secret file the caller names (the HTTPS key)", async () => {
    const dir = freshDir("https-key");
    const key = path.join(dir, "key.pem");
    fs.writeFileSync(key, "KEY");
    const result = await setDataPaths({ logsDir: dir }, false, { secretPaths: [key] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/secret/i);
  });

  it("refuses the program folder, a folder inside it and one holding it; allows its own logs folder", () => {
    const programDir = getPanelProgramDir();
    expect(logsDirRefusal(programDir)).toMatch(/program folder/i);
    expect(logsDirRefusal(path.join(programDir, "server"))).toMatch(/program folder/i);
    expect(logsDirRefusal(path.dirname(programDir))).toMatch(/program folder/i);
    expect(logsDirRefusal(path.join(programDir, "logs"))).toBeNull();
    expect(logsDirRefusal(path.join(programDir, "logs", "archive"))).toBeNull();
  });

  it("still accepts an unrelated folder", async () => {
    const dir = freshDir("plain-logs");
    const result = await setDataPaths({ logsDir: dir }, false);
    expect(result.success).toBe(true);
    expect(getDataPaths().logsDir).toBe(dir);
  });
});

// SECURITY (2026-10-28, R1-3): the data folder (db.json, jwt.secret,
// *.secret) could be moved into <program>/client/dist, which the panel serves
// to anyone without a sign-in, so its secrets became downloadable.
describe("setDataPaths: the data folder stays out of the program and served folders", () => {
  it("refuses a data folder inside the served web client, the program folder, or one holding it", async () => {
    const programDir = getPanelProgramDir();
    const distDir = path.join(programDir, "client", "dist");
    const distExisted = fs.existsSync(distDir);
    const servedTarget = path.join(distDir, "zcp-r1-3");
    try {
      for (const dataDir of [servedTarget, programDir, path.join(programDir, "server"), path.dirname(programDir)]) {
        const before = getDataPaths().dataDir;
        const result = await setDataPaths({ dataDir }, false);
        expect(result.success, dataDir).toBe(false);
        expect(result.code).toBe("PANEL_DATA_FOLDER_REFUSED");
        expect(getDataPaths().dataDir).toBe(before);
      }
      expect(fs.existsSync(servedTarget)).toBe(false);
    } finally {
      fs.rmSync(distExisted ? servedTarget : distDir, { recursive: true, force: true });
    }
  });

  it("refuses the packaged build's served client folder inside the data folder", async () => {
    const result = await setDataPaths(
      { dataDir: path.join(getDataPaths().dataDir, ".embedded-client", "bundle", "x") },
      false,
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("PANEL_DATA_FOLDER_REFUSED");
  });

  it("allows the default data folder, a folder inside it, and a folder elsewhere", () => {
    const programDir = getPanelProgramDir();
    expect(dataDirRefusal(path.join(programDir, "data"))).toBeNull();
    expect(dataDirRefusal(path.join(programDir, "data", "moved"))).toBeNull();
    expect(dataDirRefusal(path.join(programDir, "data", ".embedded-client", "b"))).toMatch(/serves/i);
    expect(dataDirRefusal(freshDir("other-disk"))).toBeNull();
  });

  // Adversary pass: the typed path is outside the program folder, but a
  // junction leads into it (and a case variant on Windows).
  it("refuses a junction into the program folder and, on Windows, a case variant", async () => {
    const programDir = getPanelProgramDir();
    const holder = freshDir("program-junction");
    const link = path.join(holder, "alias");
    fs.symlinkSync(path.join(programDir, "client"), link, "junction");
    const result = await setDataPaths({ dataDir: path.join(link, "dist", "x") }, false);
    expect(result.success).toBe(false);
    expect(result.code).toBe("PANEL_DATA_FOLDER_REFUSED");
    expect(fs.existsSync(path.join(programDir, "client", "dist", "x"))).toBe(false);
    if (process.platform === "win32") {
      expect(dataDirRefusal(path.join(programDir.toUpperCase(), "CLIENT", "DIST", "x"))).not.toBeNull();
    }
  });

  // Adversary pass: the system-folder blocklist was matched on the typed
  // path only, so a junction into a blocked folder passed.
  it("refuses a junction into a protected system folder", async (ctx) => {
    if (process.platform !== "win32") return ctx.skip(); // BLOCKED_PREFIXES is platform-specific
    const holder = freshDir("system-junction");
    const link = path.join(holder, "alias");
    fs.symlinkSync("C:\\ProgramData", link, "junction");
    const name = `zcp-r1-3-${process.pid}-${Date.now()}`;
    try {
      const result = await setDataPaths({ dataDir: path.join(link, name) }, false);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/protected system directory/i);
    } finally {
      fs.rmSync(path.join("C:\\ProgramData", name), { recursive: true, force: true });
    }
  });
});

// SECURITY (2026-10-28, CodeQL #27 / extra): on Windows a network share or
// device path was accepted as the data or logs folder, and the write probe
// signed the panel's account in to that host (its NTLM login) before
// anything refused it.
describe.skipIf(process.platform !== "win32")("setDataPaths: no network share or device path", () => {
  it("refuses one before any file call touches it", async () => {
    const isNetworkPath = (p) => /^[\\/]{2}/.test(String(p));
    const touched = [];
    const record = (name, real) => (p, ...rest) => {
      if (isNetworkPath(p)) {
        touched.push(`${name} ${p}`);
        const err = new Error("ENOENT (test: never really looked up)");
        err.code = "ENOENT";
        throw err;
      }
      return real(p, ...rest);
    };
    const spies = [
      vi.spyOn(fs, "mkdirSync").mockImplementation(record("mkdirSync", fs.mkdirSync.bind(fs))),
      vi.spyOn(fs, "writeFileSync").mockImplementation(record("writeFileSync", fs.writeFileSync.bind(fs))),
      vi.spyOn(fs, "existsSync").mockImplementation(record("existsSync", fs.existsSync.bind(fs))),
      vi.spyOn(fs, "statSync").mockImplementation(record("statSync", fs.statSync.bind(fs))),
      vi.spyOn(fs.realpathSync, "native").mockImplementation(record("realpathSync.native", fs.realpathSync.native.bind(fs))),
    ];
    try {
      for (const request of [
        { dataDir: "\\\\attacker\\share\\panel" },
        { logsDir: "//attacker/share/logs" },
        { dataDir: "\\\\?\\UNC\\attacker\\share\\panel" },
        { dataDir: "\\\\?\\C:\\zcp-device-path" },
      ]) {
        const before = getDataPaths();
        const result = await setDataPaths(request, true);
        expect(result.success, JSON.stringify(request)).toBe(false);
        expect(result.code).toBe("FOLDER_NETWORK_SHARE_REFUSED");
        expect(getDataPaths()).toEqual(before);
      }
      expect(touched).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("still accepts a local folder", async () => {
    const dir = freshDir("local-after-unc");
    const result = await setDataPaths({ dataDir: dir }, false);
    expect(result.success).toBe(true);
  });
});
