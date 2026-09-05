import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Windows analogue of the root-first-run trap (server/utils/
// firstRunOwnershipCheck.js, Linux-only). 2026-09-05, install-shapes
// privilege sweep: getDataPaths() derives its default dataDir/logsDir as a
// subfolder of wherever the exe lives (path.dirname(process.execPath) when
// packaged) and, before this fix, had no guard at all around the mkdirSync
// that creates it. Reproduced live, from an ordinary non-admin shell, with
// NO chmod/self-inflicted denial needed (unlike the Linux test, which has
// to fake one against its own account): "C:\Program Files\" already denies
// write to a standard account by the OS's own ACL. Pointing a fake
// process.execPath under it and calling getDataPaths() throws a raw,
// uncaught EPERM with no indication of why -- exactly the shape this
// project's own docs (docs/install/windows.md) steer users away from by
// example (`C:\ZomboidPanel`) but never actually warn against, and exactly
// the class of bug the Linux ownership check exists to turn into ONE clear
// diagnostic instead of a bare stack trace.
//
// server/utils/paths.js computes baseDir from process.execPath ONCE, at
// module top level -- each case below needs a fresh module instance to pick
// up a different execPath, so this imports with a cache-busting query
// string per test rather than the module-level static import every other
// test file in this suite uses.
const describeWindowsOnly = process.platform === "win32" ? describe : describe.skip;

async function freshPathsModule() {
  vi.resetModules();
  return import("../utils/paths.js");
}

function setExecPath(p) {
  Object.defineProperty(process, "execPath", { value: p, configurable: true });
}

describeWindowsOnly("Windows Program Files ownership trap (getDataPaths)", () => {
  let originalExecPath;
  let originalPathsConfigEnv;
  let tmpRoot;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalExecPath) setExecPath(originalExecPath);
    if (originalPathsConfigEnv === undefined) {
      delete process.env.PANEL_PATHS_CONFIG_PATH;
    } else {
      process.env.PANEL_PATHS_CONFIG_PATH = originalPathsConfigEnv;
    }
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  });

  it("control: a genuinely writable install directory creates data/logs normally", async () => {
    originalExecPath = process.execPath;
    originalPathsConfigEnv = process.env.PANEL_PATHS_CONFIG_PATH;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-winpaths-"));
    process.env.PANEL_PATHS_CONFIG_PATH = path.join(tmpRoot, "paths.config.json");
    process.pkg = {};
    setExecPath(path.join(tmpRoot, "ZomboidControlPanel.exe"));

    const { getDataPaths } = await freshPathsModule();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});

    const result = getDataPaths();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(result.dataDir)).toBe(true);
    expect(fs.existsSync(result.logsDir)).toBe(true);
  });

  it("a real, unmocked EPERM against a Program-Files-shaped path exits 77 with a named cause instead of an uncaught crash", async () => {
    originalExecPath = process.execPath;
    originalPathsConfigEnv = process.env.PANEL_PATHS_CONFIG_PATH;
    process.pkg = {};
    // No chmod/self-inflicted denial -- Program Files already refuses write
    // to a standard account. If this test is ever run elevated, the
    // directory genuinely will be creatable and this assertion correctly
    // fails loudly rather than silently passing for the wrong reason.
    const target = path.join(
      "C:\\Program Files",
      `zcp-ownership-trap-test-${process.pid}-${Date.now()}`,
    );
    setExecPath(path.join(target, "ZomboidControlPanel.exe"));
    // The suite's own global setup points PANEL_PATHS_CONFIG_PATH at a
    // shared, already-writable temp config for every other test's safety --
    // exactly what would otherwise mask this scenario, since a config
    // override with its own dataDir short-circuits the exe-relative default
    // this test exists to exercise. Point it at a config that does not
    // exist instead, so getDataPaths() falls through to that default.
    process.env.PANEL_PATHS_CONFIG_PATH = path.join(target, "paths.config.json");

    const { getDataPaths } = await freshPathsModule();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // process.exit is mocked to a no-op here, so execution falls through to
    // the unconditional `throw err` right after it -- real production code
    // never reaches that line, since a real process.exit(77) never returns.
    expect(() => getDataPaths()).toThrow(/EPERM|EACCES/);

    expect(exitSpy).toHaveBeenCalledWith(77);
    const message = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(message).toMatch(/Program Files/i);
    expect(message).toMatch(/Run as administrator/i);
    expect(message).toContain(target);
  });
});
