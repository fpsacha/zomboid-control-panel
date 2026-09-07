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

    const staleBinaryPartial = "ZomboidControlPanel.exe.new.partial.4242";
    const staleZipPartial = ".client-dist-1.3.0.partial.4242.zip";
    const staleTarPartial = ".client-dist-1.3.0.partial.4242.tar.gz";
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

  it("does nothing when not running packaged", () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-partials-devmode-"));
    const exePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(exePath, "fake-exe");
    setExecPath(exePath);
    const zipPartial = ".client-dist-1.3.0.partial.4242.zip";
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
});
