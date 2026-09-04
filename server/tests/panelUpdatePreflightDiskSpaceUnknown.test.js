import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 2026-09-04, Dwight's finding: `if (free !== null && free < needed)` reads
// as careful, but the other half was silent -- a null free (statfs
// unsupported, or a swallowed error) or a thrown error both fell through
// with no warning at all, identical to no check having run. This is the
// exact "checksPerformed:false, not a bare ok:true" honesty the Docker
// preflight path was deliberately built with; this check never got it.

process.pkg = {};

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

describe("preflight() surfaces an unknown free-disk-space result instead of staying silent", () => {
  let scratchDir;
  let fakeExePath;
  let originalExecPath;

  function setExecPath(p) {
    Object.defineProperty(process, "execPath", { value: p, configurable: true });
  }

  function makeChecker() {
    const checker = new PanelUpdateChecker();
    checker.latestRelease = {
      version: "9.9.9",
      assets: [{ name: "ZomboidControlPanel.exe", size: 1024 }],
    };
    checker.updateAvailable = true;
    return checker;
  }

  function unknownWarning(result) {
    return result.warningDetails.find(
      (w) => w.key === "updates.preflight.diskSpaceUnknown",
    );
  }

  afterEach(() => {
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    if (originalExecPath) setExecPath(originalExecPath);
    vi.restoreAllMocks();
  });

  it("warns when getFreeDiskSpace resolves to null", async () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-disk-"));
    fakeExePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(fakeExePath, "fake-exe");
    setExecPath(fakeExePath);

    const checker = makeChecker();
    vi.spyOn(checker, "getFreeDiskSpace").mockResolvedValue(null);

    const result = await checker.preflight();
    expect(unknownWarning(result)).toBeDefined();
    expect(result.info.freeBytes).toBeNull();
    // Must not also silently pass as if space were confirmed sufficient --
    // no blocker either, since we genuinely do not know.
    expect(result.blockerDetails.some((b) => b.key === "updates.preflight.diskSpace")).toBe(false);
  });

  it("warns when getFreeDiskSpace throws", async () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-disk-"));
    fakeExePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(fakeExePath, "fake-exe");
    setExecPath(fakeExePath);

    const checker = makeChecker();
    vi.spyOn(checker, "getFreeDiskSpace").mockRejectedValue(new Error("statfs exploded"));

    const result = await checker.preflight();
    expect(unknownWarning(result)).toBeDefined();
    expect(result.info.freeBytes).toBeNull();
  });

  it("stays silent on disk space when a real, sufficient value is available", async () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-disk-"));
    fakeExePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(fakeExePath, "fake-exe");
    setExecPath(fakeExePath);

    const checker = makeChecker();
    vi.spyOn(checker, "getFreeDiskSpace").mockResolvedValue(1024 * 1024 * 1024 * 10); // 10GB

    const result = await checker.preflight();
    expect(unknownWarning(result)).toBeUndefined();
    expect(result.info.freeBytes).toBe(1024 * 1024 * 1024 * 10);
  });
});
