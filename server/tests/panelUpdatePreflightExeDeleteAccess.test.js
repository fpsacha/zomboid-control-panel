import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// probeExeDeleteAccess() answers "can this process rename its own binary"
// by requesting ONLY the DELETE right on process.execPath and closing the
// handle immediately -- see the method's own doc comment in
// panelUpdateChecker.js for why WRITE (and a rename-there-and-back dance)
// are both wrong probes for this specific file. This suite covers the
// three-way result (true/false/null) in isolation with child_process
// mocked (fast, deterministic, no real powershell.exe/Add-Type compile),
// then how preflight() folds that result into blockers/warnings.

const mockExecFile = vi.fn();
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (...args) => mockExecFile(...args) };
});

// preflight()'s inProgramFiles check is `/^c:\\program files/i.test(exeDir)`
// against `path.dirname(exePath)` -- and Node's bare `path` module picks
// posix or win32 SEMANTICS based on the REAL host OS at process start, not
// on process.platform (which this file DOES patch below, but that only
// fools plain `process.platform === "win32"` string checks inside
// panelUpdateChecker.js, never the path module's own internal binding).
// On a Linux test runner, path.dirname("C:\\Program Files\\...") returns
// "." (no backslash is a separator in posix mode), which can never match
// the regex -- the exact "hardcoded backslash literal fails on Linux"
// class already caught once in this codebase (see mapProxySuspectVerdicts
// .test.js's note on 00bfa2b7). Forcing dirname to win32 semantics here is
// safe for every OTHER path in this file too: win32.dirname also accepts
// forward slashes, so it returns the identical answer for the real,
// host-native posix temp dirs setupRealDir() below actually creates.
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, dirname: actual.win32.dirname },
    dirname: actual.win32.dirname,
  };
});

process.pkg = {};

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

function setPlatform(value) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

describe("probeExeDeleteAccess() -- DELETE-only handle probe, never a write-open", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    setPlatform(originalPlatform);
    mockExecFile.mockReset();
  });

  it("returns null without shelling out at all on a non-Windows platform", async () => {
    setPlatform("linux");
    const checker = new PanelUpdateChecker();
    const result = await checker.probeExeDeleteAccess("/some/path");
    expect(result).toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("returns true when the probe script reports GRANTED", async () => {
    setPlatform("win32");
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(null, "GRANTED\r\n", ""),
    );
    const checker = new PanelUpdateChecker();
    const result = await checker.probeExeDeleteAccess("C:\\panel\\app.exe");
    expect(result).toBe(true);
  });

  it("returns false ONLY for a genuine ERROR_ACCESS_DENIED (code 5)", async () => {
    setPlatform("win32");
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(null, "DENIED:5\r\n", ""),
    );
    const checker = new PanelUpdateChecker();
    const result = await checker.probeExeDeleteAccess("C:\\Program Files\\panel\\app.exe");
    expect(result).toBe(false);
  });

  it("returns null (not false) for a DENIED carrying a different Win32 code -- not a permission verdict", async () => {
    setPlatform("win32");
    // 32 = ERROR_SHARING_VIOLATION -- ambiguous with ACCESS_DENIED in prose
    // but not the same thing; must not be reported as a confident denial.
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(null, "DENIED:32\r\n", ""),
    );
    const checker = new PanelUpdateChecker();
    const result = await checker.probeExeDeleteAccess("C:\\panel\\app.exe");
    expect(result).toBeNull();
  });

  it("returns null, never false, when powershell.exe itself fails/times out -- the exact environment this exists to help diagnose can also block the tool used to ask", async () => {
    setPlatform("win32");
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(new Error("ETIMEDOUT"), "", ""),
    );
    const checker = new PanelUpdateChecker();
    const result = await checker.probeExeDeleteAccess("C:\\panel\\app.exe");
    expect(result).toBeNull();
  });

  it("returns null on malformed/empty output rather than guessing", async () => {
    setPlatform("win32");
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => cb(null, "", ""));
    const checker = new PanelUpdateChecker();
    const result = await checker.probeExeDeleteAccess("C:\\panel\\app.exe");
    expect(result).toBeNull();
  });

  it("returns null if execFile throws synchronously instead of erroring via callback", async () => {
    setPlatform("win32");
    mockExecFile.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const checker = new PanelUpdateChecker();
    const result = await checker.probeExeDeleteAccess("C:\\panel\\app.exe");
    expect(result).toBeNull();
  });
});

describe("preflight() folds the exe-delete probe into blockers/warnings", () => {
  let scratchDir;
  let originalExecPath;
  const originalPlatform = process.platform;

  function setExecPath(p) {
    Object.defineProperty(process, "execPath", { value: p, configurable: true });
  }

  function makeChecker(probeResult) {
    const checker = new PanelUpdateChecker();
    checker.latestRelease = { version: "9.9.9", assets: [] };
    checker.updateAvailable = true;
    vi.spyOn(checker, "probeExeDeleteAccess").mockResolvedValue(probeResult);
    return checker;
  }

  afterEach(() => {
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    if (originalExecPath) setExecPath(originalExecPath);
    setPlatform(originalPlatform);
  });

  // A REAL scratch dir (folder-write-probe succeeds, keeping assertions
  // free of an unrelated folderNotWritableWindows blocker).
  function setupRealDir() {
    setPlatform("win32");
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-exeprobe-"));
    const fakeExePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(fakeExePath, "fake-exe");
    setExecPath(fakeExePath);
    return fakeExePath;
  }

  // A FABRICATED path literally under C:\Program Files, never created on
  // disk -- the point is testing the `inProgramFiles` path-string branch,
  // not real Windows ACLs. The folder-write-probe will fail (ENOENT) and
  // add its own unrelated blocker; none of these tests assert on that.
  function setupFakeProgramFiles() {
    setPlatform("win32");
    scratchDir = undefined;
    originalExecPath = process.execPath;
    setExecPath("C:\\Program Files\\ZomboidControlPanel\\ZomboidControlPanel.exe");
  }

  it("blocks the update on a verified DELETE denial, regardless of install path", async () => {
    setupRealDir();
    const result = await makeChecker(false).preflight();
    expect(result.ok).toBe(false);
    expect(
      result.blockerDetails.some(
        (b) => b.key === "updates.preflight.exeNotRenameable",
      ),
    ).toBe(true);
    expect(result.info.exeDeleteAccess).toBe(false);
  });

  it("does not block, and records the true verdict, when DELETE is confirmed granted", async () => {
    setupRealDir();
    const result = await makeChecker(true).preflight();
    expect(result.info.exeDeleteAccess).toBe(true);
    expect(
      result.blockerDetails.some(
        (b) => b.key === "updates.preflight.exeNotRenameable",
      ),
    ).toBe(false);
  });

  it("suppresses the generic Program-Files warning once the probe has verified the exe IS renameable -- a stale worry would be wrong information, not caution", async () => {
    setupFakeProgramFiles();
    const result = await makeChecker(true).preflight();
    expect(
      result.warningDetails.some((w) => w.key === "updates.preflight.programFiles"),
    ).toBe(false);
  });

  it("falls back to the original path-based Program-Files warning when the probe is inconclusive -- unchanged behavior for that case", async () => {
    setupFakeProgramFiles();
    const result = await makeChecker(null).preflight();
    expect(
      result.warningDetails.some((w) => w.key === "updates.preflight.programFiles"),
    ).toBe(true);
    expect(
      result.blockerDetails.some(
        (b) => b.key === "updates.preflight.exeNotRenameable",
      ),
    ).toBe(false);
  });

  it("still blocks on a verified denial even OUTSIDE Program Files -- a per-file AV/ACL block anywhere, not just the path heuristic's one known shape", async () => {
    setupRealDir();
    const result = await makeChecker(false).preflight();
    expect(result.ok).toBe(false);
    expect(
      result.blockerDetails.some(
        (b) => b.key === "updates.preflight.exeNotRenameable",
      ),
    ).toBe(true);
    expect(
      result.warningDetails.some((w) => w.key === "updates.preflight.programFiles"),
    ).toBe(false);
  });
});
