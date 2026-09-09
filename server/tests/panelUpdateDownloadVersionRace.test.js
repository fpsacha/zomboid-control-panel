import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Windows-updater hunt, 2026-09-09 (god: "adversarial hunt on
// panelUpdateChecker.js -- what the user is TOLD is the same defect class
// as a wrong-but-confident success/failure message"):
//
// downloadUpdate() resolves `asset`/`clientArchive` from `this.latestRelease`
// early, then spends several `await`s (two downloads, two checksum
// verifications, a client-dist extraction) before it used to read
// `this.latestRelease.version` again -- repeatedly -- to label the journal
// it stages, set `this._stagedVersionCache`, log a line, emit
// "panel:updateReady", and build its own success message.
// `this.latestRelease` is reassigned wholesale (a fresh object, not a
// mutation) by checkForUpdate() -- which runs on its own periodic 6-hour
// timer AND on demand from a manual "Check for Updates" click, either of
// which can land while a download that takes any real amount of time is
// still in flight.
//
// Traced precisely (not assumed): stageClientDist() has its own internal
// read of `this.latestRelease?.version`, compared against the actual
// archive's manifest.version via validateReleaseManifest() -- so a race
// landing BEFORE that read gets caught there and turns into a loud (if
// confusingly-worded) "version does not match" download failure, not a
// silent mislabel. And between that internal check and downloadUpdate()'s
// OWN first two post-stage reads (the journal `version:` field and
// `_stagedVersionCache`), there is no `await` at all -- pure synchronous
// fs calls -- so those two specific reads cannot observe a value the check
// didn't already validate.
//
// The one real, reachable gap is the stretch AFTER `await setSetting(...)`
// persists the staged-version setting: everything read from
// `this.latestRelease.version` past that point (the "staged at ..." log
// line, the `panel:updateReady` socket emit the client turns into a toast,
// and this call's own HTTP response `message`) sits on the far side of a
// genuine yield point with no protecting check of its own. A checkForUpdate()
// tick landing there makes the panel tell the operator "Update to v1.2.0
// downloaded" when the binary it actually downloaded, verified, and staged
// was v1.1.0 -- confusing at best, actively misleading if the operator uses
// that number to judge whether the right release will apply.
process.pkg = {};

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    setSetting: vi.fn(async (key, value) => {
      if (key === "stagedPanelUpdateVersion") {
        // Simulate checkForUpdate() (background 6h timer, or a manual
        // "Check for Updates" click) landing during this specific await --
        // the one genuine yield point downstream of stageClientDist()'s own
        // protective version check.
        global.__raceLatestRelease?.();
      }
      return actual.setSetting(key, value);
    }),
  };
});

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

describe("downloadUpdate(): messages describing the staged version must not go stale after the update-bundle write", () => {
  let scratchDir;
  let originalExecPath;

  function setExecPath(p) {
    Object.defineProperty(process, "execPath", { value: p, configurable: true });
  }

  afterEach(() => {
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    if (originalExecPath) setExecPath(originalExecPath);
    delete global.__raceLatestRelease;
  });

  it("keeps the log line, updateReady emit, and success message pinned to the version actually downloaded and staged, even if checkForUpdate() swaps in a newer release during the trailing setSetting() await", async () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-version-race-"));
    const exePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(exePath, "fake-exe");
    setExecPath(exePath);

    const emitted = [];
    const checker = new PanelUpdateChecker({ emit: (event, payload) => emitted.push({ event, payload }) });
    checker.currentVersion = "1.0.0";
    checker.updateAvailable = true;

    // Both platforms' asset shapes, deliberately -- this test must pass
    // identically under `npx vitest` on a Windows dev box AND inside a
    // clean-clone gate running under WSL/Linux (asset selection in
    // downloadUpdate() branches on process.platform, so a Windows-only
    // fixture here made the whole download return `no Linux binary found`
    // before ever reaching this test's real assertions on a Linux runner --
    // exactly the god-reported clean-clone red).
    const oldRelease = {
      version: "1.1.0",
      assets: [
        {
          name: "ZomboidControlPanel.exe",
          size: 8,
          downloadUrl: "https://example.invalid/old.exe",
        },
        {
          name: "ZomboidControlPanel-windows.zip",
          size: 8,
          downloadUrl: "https://example.invalid/old-windows.zip",
        },
        {
          name: "ZomboidControlPanel",
          size: 8,
          downloadUrl: "https://example.invalid/old-linux-binary",
        },
        {
          name: "ZomboidControlPanel-linux.tar.gz",
          size: 8,
          downloadUrl: "https://example.invalid/old-linux.tar.gz",
        },
      ],
    };
    checker.latestRelease = oldRelease;

    checker.preflight = async () => ({ ok: true, blockers: [], warnings: [] });
    checker.verifyChecksum = async () => true;
    checker.downloadFile = async (_url, destPath) => {
      fs.writeFileSync(destPath, "stub");
    };
    // Real fixture (not a bare stub path) so the REAL stageUpdateBundle()
    // below actually runs end-to-end -- this test's whole point is that
    // stageUpdateBundle()'s own reads of the version are fine; only the
    // reads strictly after it (past the setSetting() await) are exposed.
    const incomingClientPath = path.join(scratchDir, ".incoming-client-stub");
    fs.mkdirSync(incomingClientPath, { recursive: true });
    fs.writeFileSync(path.join(incomingClientPath, "index.html"), "<html></html>");
    fs.writeFileSync(
      path.join(incomingClientPath, "build-info.json"),
      JSON.stringify({ panelVersion: "1.1.0", buildSha: "deadbeef", apiContractVersion: 1 }),
    );
    checker.stageClientDist = async () => ({
      incomingClientPath,
      metadata: { panelVersion: "1.1.0", buildSha: "deadbeef", apiContractVersion: 1 },
    });

    global.__raceLatestRelease = () => {
      checker.latestRelease = { version: "1.2.0", assets: oldRelease.assets };
    };

    const result = await checker.downloadUpdate();

    expect(result.success).toBe(true);
    // The persisted label (what reconcilePendingUpdate() keys off after a
    // restart) must be the version actually downloaded and verified.
    expect(checker._stagedVersionCache).toBe("1.1.0");
    // The user-facing surfaces must agree with it, not with whatever
    // this.latestRelease happened to become during the trailing await.
    expect(result.message).toContain("1.1.0");
    expect(result.message).not.toContain("1.2.0");
    const readyEvent = emitted.find((e) => e.event === "panel:updateReady");
    expect(readyEvent?.payload?.version).toBe("1.1.0");
  });
});
