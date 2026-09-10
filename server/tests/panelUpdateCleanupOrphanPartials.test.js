import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// cleanupOrphanPartials() is called once at start() to sweep up interrupted
// downloads. Its regex (`\.partial\.\d+$`) only matched the staged-binary
// shape (`<stagedPath>.partial.<pid>`, no further suffix) -- the client
// archive download uses a DIFFERENT shape with an extension trailing the
// pid (`.client-dist-<version>.partial.<pid>.zip` / `.tar.gz`), which the
// `$`-anchored pattern could never match. A process crash between a
// successful client-archive download and its own happy-path unlink (inside
// stageClientDist(), or the gap before downloadAndStageUpdate()'s own
// cleanup) left one of these on disk on every single scan forever -- an
// accumulating leak matching only half of "interrupted download".
//
// 2026-09-10 (panel-update-download-temp-path-is-per-process-not-per-call):
// the callId embedded in both shapes changed from a bare `<pid>` (e.g.
// "4242") to `<pid>-<seq>` (e.g. "4242-1") -- fixtures below use the new
// shape throughout. The dedicated test near the bottom of this file
// generates its fixture's callId via the REAL nextPartialCallId(), not a
// hardcoded guess at the current shape -- a regex change made without also
// updating the naming convention (or vice versa) fails this test the same
// way it would fail cleanup in production: silently, by no longer matching.
process.pkg = {};

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

describe("cleanupOrphanPartials() sweeps both partial-download naming shapes", () => {
  let scratchDir;
  let originalExecPath;

  function setExecPath(p) {
    Object.defineProperty(process, "execPath", { value: p, configurable: true });
  }

  afterEach(() => {
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    if (originalExecPath) setExecPath(originalExecPath);
  });

  it("removes orphaned staged-binary AND client-archive partials, and leaves unrelated files alone", () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-partials-"));
    const exePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(exePath, "fake-exe");
    setExecPath(exePath);

    const staleBinaryPartial = "ZomboidControlPanel.exe.new.partial.4242-1";
    const staleZipPartial = ".client-dist-1.3.0.partial.4242-1.zip";
    const staleTarPartial = ".client-dist-1.3.0.partial.4242-1.tar.gz";
    const unrelatedFile = "update-bundle.json";
    for (const name of [staleBinaryPartial, staleZipPartial, staleTarPartial, unrelatedFile]) {
      fs.writeFileSync(path.join(scratchDir, name), "leftover");
    }

    const checker = new PanelUpdateChecker();
    checker.cleanupOrphanPartials();

    expect(fs.existsSync(path.join(scratchDir, staleBinaryPartial))).toBe(false);
    expect(fs.existsSync(path.join(scratchDir, staleZipPartial))).toBe(false);
    expect(fs.existsSync(path.join(scratchDir, staleTarPartial))).toBe(false);
    // Never touch a file it didn't create, even one sitting in the same dir.
    expect(fs.existsSync(path.join(scratchDir, unrelatedFile))).toBe(true);
    expect(fs.existsSync(exePath)).toBe(true);
  });

  it("god-dispatched fix (harden-updater-fileops #2, destructive): leaves an UNRELATED file alone even when its name happens to end in .partial.<digits> -- the pattern must require the panel's own exe-basename prefix, not just the suffix shape", () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-partials-collision-"));
    const exePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(exePath, "fake-exe");
    setExecPath(exePath);

    // Same suffix shape (`.partial.<digits>`) as a real staged-binary
    // orphan, but a completely different prefix -- exactly what some other
    // tool (or the operator's own file) sharing this folder could produce.
    // exeDir is wherever the operator installed the panel, not a directory
    // this process owns exclusively.
    const foreignPartial = "quarterly-report.xlsx.partial.4242-1";
    const realPartial = "ZomboidControlPanel.exe.new.partial.4242-1";
    fs.writeFileSync(path.join(scratchDir, foreignPartial), "someone else's file");
    fs.writeFileSync(path.join(scratchDir, realPartial), "leftover");

    const checker = new PanelUpdateChecker();
    checker.cleanupOrphanPartials();

    expect(fs.existsSync(path.join(scratchDir, foreignPartial))).toBe(true);
    expect(fs.existsSync(path.join(scratchDir, realPartial))).toBe(false);
  });

  it("does nothing when not running packaged", () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-partials-devmode-"));
    const exePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(exePath, "fake-exe");
    setExecPath(exePath);
    const zipPartial = ".client-dist-1.3.0.partial.4242-1.zip";
    fs.writeFileSync(path.join(scratchDir, zipPartial), "leftover");

    const previousPkg = process.pkg;
    delete process.pkg;
    try {
      const checker = new PanelUpdateChecker();
      checker.cleanupOrphanPartials();
    } finally {
      process.pkg = previousPkg;
    }

    expect(fs.existsSync(path.join(scratchDir, zipPartial))).toBe(true);
  });

  it("panel-update-download-temp-path-is-per-process-not-per-call, 2026-09-10: matches a file named with the REAL callId nextPartialCallId() produces, not a hardcoded guess at its shape", () => {
    // This is the test god asked for: proof the cleanup regex MATCHES the
    // current naming convention, not proof the regex merely compiles or
    // that the OLD shape still matches (which would prove nothing about a
    // shape that changed). Deriving the fixture's name from the real
    // production method means a future change to nextPartialCallId() that
    // isn't mirrored in cleanupOrphanPartials()'s regex fails THIS test,
    // the same silent way it would fail cleanup for real -- no match, no
    // delete, but here as a red test instead of an invisible leak.
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-partials-real-callid-"));
    const exePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(exePath, "fake-exe");
    setExecPath(exePath);

    const checker = new PanelUpdateChecker();
    const callId = checker.nextPartialCallId();

    const binaryPartial = `ZomboidControlPanel.exe.new.partial.${callId}`;
    const zipPartial = `.client-dist-1.3.0.partial.${callId}.zip`;
    const tarPartial = `.client-dist-1.3.0.partial.${callId}.tar.gz`;
    for (const name of [binaryPartial, zipPartial, tarPartial]) {
      fs.writeFileSync(path.join(scratchDir, name), "leftover");
    }

    checker.cleanupOrphanPartials();

    expect(fs.existsSync(path.join(scratchDir, binaryPartial))).toBe(false);
    expect(fs.existsSync(path.join(scratchDir, zipPartial))).toBe(false);
    expect(fs.existsSync(path.join(scratchDir, tarPartial))).toBe(false);
  });

  it("also sweeps the pre-fix bare-<pid> shape (no counter suffix) -- a one-time transitional orphan from a panel binary that crashed before this commit shipped", () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-partials-legacy-shape-"));
    const exePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(exePath, "fake-exe");
    setExecPath(exePath);

    const legacyBinaryPartial = "ZomboidControlPanel.exe.new.partial.4242";
    const legacyZipPartial = ".client-dist-1.3.0.partial.4242.zip";
    for (const name of [legacyBinaryPartial, legacyZipPartial]) {
      fs.writeFileSync(path.join(scratchDir, name), "leftover");
    }

    const checker = new PanelUpdateChecker();
    checker.cleanupOrphanPartials();

    expect(fs.existsSync(path.join(scratchDir, legacyBinaryPartial))).toBe(false);
    expect(fs.existsSync(path.join(scratchDir, legacyZipPartial))).toBe(false);
  });
});
