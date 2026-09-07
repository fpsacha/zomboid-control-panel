import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelUpdateChecker } from "../services/panelUpdateChecker.js";

const roots = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-linux-managed-"));
  roots.push(root);
  const incoming = path.join(root, "incoming");
  const live = path.join(root, "live");
  fs.mkdirSync(incoming);
  fs.mkdirSync(live);
  for (const name of ["start.sh", "zomboid-panel.service", "install-linux-service.sh"]) {
    fs.writeFileSync(path.join(incoming, name), `new-${name}`);
    fs.writeFileSync(path.join(live, name), `old-${name}`);
  }
  return { incoming, live };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Split into two phases (staging at download time, activation only after
// the binary/client update is fully committed -- see
// activateStagedLinuxLauncherFiles()'s own comment in panelUpdateChecker.js
// for why the old single-call replaceManagedLinuxFiles() could land these
// files ahead of a binary/client swap that later rolls back). These tests
// exercise both phases together, the same way the real update flow does.
describe("Linux managed updater files", () => {
  it("stages then activates the launcher and service templates together", () => {
    const { incoming, live } = fixture();
    const checker = new PanelUpdateChecker();
    checker.stageLinuxLauncherFiles(incoming, live);
    const activated = checker.activateStagedLinuxLauncherFiles(live);

    expect(activated).toBe(true);
    expect(fs.readFileSync(path.join(live, "start.sh"), "utf8")).toBe("new-start.sh");
    expect(fs.readFileSync(path.join(live, "zomboid-panel.service"), "utf8"))
      .toBe("new-zomboid-panel.service");
    expect(fs.existsSync(path.join(live, "start.sh.previous"))).toBe(false);
    expect(fs.existsSync(PanelUpdateChecker.getLinuxLauncherStageDir(live))).toBe(false);
  });

  it("does nothing and returns false when nothing was staged", () => {
    const { live } = fixture();
    expect(new PanelUpdateChecker().activateStagedLinuxLauncherFiles(live)).toBe(false);
    expect(fs.readFileSync(path.join(live, "start.sh"), "utf8")).toBe("old-start.sh");
  });

  it("stageLinuxLauncherFiles refuses when the release archive is missing a managed file", () => {
    const { incoming, live } = fixture();
    fs.rmSync(path.join(incoming, "install-linux-service.sh"));
    expect(() => new PanelUpdateChecker().stageLinuxLauncherFiles(incoming, live))
      .toThrow("install-linux-service.sh");
  });

  // State-machine sweep, 2026-09-07: this used to back up the live file by
  // RENAMING it out of the way before renaming the staged replacement in --
  // a crash/OOM/power-loss between those two renames left `target` absent
  // from disk entirely (the same disease as applyUpdateBundle()'s binary
  // swap, fix 03431c65, just on a much smaller file). Fixed by backing up
  // via COPY (target stays put) and replacing it with a single same-
  // directory rename onto an EXISTING destination, which POSIX guarantees
  // is atomic -- so target is always either the old file or the new one,
  // never neither. A real process-kill mid-swap isn't something a unit
  // test can force between two synchronous statements, so this proves the
  // structural property instead: instrument every fs call activation makes
  // and assert the live file's existence never lapses at any point in a
  // real, unmocked run.
  it("never lets the live file's existence lapse during a successful swap, even for a moment (the property that makes a crash mid-swap harmless)", () => {
    const { incoming, live } = fixture();
    const checker = new PanelUpdateChecker();
    checker.stageLinuxLauncherFiles(incoming, live);
    const target = path.join(live, "zomboid-panel.service");

    let sawMissing = false;
    const realCopyFileSync = fs.copyFileSync.bind(fs);
    const realRenameSync = fs.renameSync.bind(fs);
    const checkStillPresent = () => {
      if (!fs.existsSync(target)) sawMissing = true;
    };
    vi.spyOn(fs, "copyFileSync").mockImplementation((src, dest) => {
      const result = realCopyFileSync(src, dest);
      checkStillPresent();
      return result;
    });
    vi.spyOn(fs, "renameSync").mockImplementation((src, dest) => {
      const result = realRenameSync(src, dest);
      checkStillPresent();
      return result;
    });

    // The file already exists before this call starts -- check that too,
    // so a regression that removes it on the very first fs operation
    // (before this spy's first post-call check) is still caught.
    expect(fs.existsSync(target)).toBe(true);
    const activated = checker.activateStagedLinuxLauncherFiles(live);

    expect(activated).toBe(true);
    expect(sawMissing).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("new-zomboid-panel.service");
  });

  it("rolls back every previously activated file when a later swap fails", () => {
    const { incoming, live } = fixture();
    const checker = new PanelUpdateChecker();
    checker.stageLinuxLauncherFiles(incoming, live);

    const renameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(source).endsWith("zomboid-panel.service.new") && target === path.join(live, "zomboid-panel.service")) {
        const error = new Error("simulated swap failure");
        error.code = "EACCES";
        throw error;
      }
      return renameSync(source, target);
    });

    expect(() => checker.activateStagedLinuxLauncherFiles(live))
      .toThrow("simulated swap failure");
    expect(fs.readFileSync(path.join(live, "start.sh"), "utf8")).toBe("old-start.sh");
    expect(fs.readFileSync(path.join(live, "zomboid-panel.service"), "utf8"))
      .toBe("old-zomboid-panel.service");
  });
});
