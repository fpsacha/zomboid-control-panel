import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// god-dispatched, 2026-09-08 (harden-updater-fileops #1 follow-up):
// stageUpdateBundle() copies the verified client bundle into a fresh,
// version-named `client/dist.new-<version>` directory every time. Neither
// rollback() (Linux) nor build.js's :rollback_update (Windows) ever cleans
// this up after a failed apply -- both only restore the LIVE binary/client
// from their backups. Confirmed unreachable-by-construction before writing
// this fix: downloadUpdate() always starts a fresh download+stage cycle,
// and getStagedUpdate() -- the only gate anything uses to find a stageable
// update -- requires a currently-valid journal. Once rollback deletes the
// journal (or a crash happens before one was ever written), nothing in
// this codebase can ever discover or re-apply the orphaned directory
// again -- it's pure wasted disk, not a retry path being thrown away.
process.pkg = {};

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

describe("cleanupOrphanStagedClientDirs() sweeps abandoned dist.new-<version> directories", () => {
  let scratchDir;
  let originalExecPath;

  function setExecPath(p) {
    Object.defineProperty(process, "execPath", { value: p, configurable: true });
  }

  function setup() {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-staged-client-"));
    const exePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(exePath, "fake-exe");
    setExecPath(exePath);
    fs.mkdirSync(path.join(scratchDir, "client"), { recursive: true });
    return exePath;
  }

  afterEach(() => {
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    if (originalExecPath) setExecPath(originalExecPath);
  });

  it("removes an orphaned dist.new-<version> directory when no journal exists at all (rollback already deleted it)", () => {
    setup();
    const orphan = path.join(scratchDir, "client", "dist.new-1.2.18");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "index.html"), "<html></html>");

    const checker = new PanelUpdateChecker();
    checker.cleanupOrphanStagedClientDirs();

    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("removes an orphaned dist.new-<version> directory that a DIFFERENT journal entry no longer references", () => {
    setup();
    const orphan = path.join(scratchDir, "client", "dist.new-1.2.17");
    fs.mkdirSync(orphan, { recursive: true });
    const current = path.join(scratchDir, "client", "dist.new-1.2.19");
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(
      path.join(scratchDir, "update-bundle.json"),
      JSON.stringify({ phase: "staged", paths: { stagedClient: current } }),
    );

    const checker = new PanelUpdateChecker();
    checker.cleanupOrphanStagedClientDirs();

    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(current)).toBe(true);
  });

  it("never removes the directory the CURRENT journal's paths.stagedClient names, regardless of phase", () => {
    setup();
    const current = path.join(scratchDir, "client", "dist.new-1.2.19");
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(
      path.join(scratchDir, "update-bundle.json"),
      JSON.stringify({ phase: "awaiting_startup_ack", paths: { stagedClient: current } }),
    );

    const checker = new PanelUpdateChecker();
    checker.cleanupOrphanStagedClientDirs();

    expect(fs.existsSync(current)).toBe(true);
  });

  it("never touches an unrelated directory in client/, even the live dist folder", () => {
    setup();
    const liveDist = path.join(scratchDir, "client", "dist");
    fs.mkdirSync(liveDist, { recursive: true });
    fs.writeFileSync(path.join(liveDist, "index.html"), "<html></html>");

    const checker = new PanelUpdateChecker();
    checker.cleanupOrphanStagedClientDirs();

    expect(fs.existsSync(liveDist)).toBe(true);
  });

  it("fails toward keeping everything when the journal is present but unreadable/corrupt -- an inconclusive signal never authorises a destructive action", () => {
    setup();
    const orphan = path.join(scratchDir, "client", "dist.new-1.2.18");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "update-bundle.json"), "{not valid json");

    const checker = new PanelUpdateChecker();
    checker.cleanupOrphanStagedClientDirs();

    expect(fs.existsSync(orphan)).toBe(true);
  });

  it("does nothing when not running packaged", () => {
    setup();
    const orphan = path.join(scratchDir, "client", "dist.new-1.2.18");
    fs.mkdirSync(orphan, { recursive: true });

    const previousPkg = process.pkg;
    delete process.pkg;
    try {
      const checker = new PanelUpdateChecker();
      checker.cleanupOrphanStagedClientDirs();
    } finally {
      process.pkg = previousPkg;
    }

    expect(fs.existsSync(orphan)).toBe(true);
  });
});
