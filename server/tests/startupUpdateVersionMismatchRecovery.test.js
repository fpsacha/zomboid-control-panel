import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { recoverFromStartupInspectionFailure } from "../index.js";
import { applyUpdateBundle, stageUpdateBundle } from "../services/updateBundle.js";

// State-machine sweep, 2026-09-07 (god's dispatch): inspectPendingPanelUpdate()
// (index.js, called before httpServer.listen()) throws version_mismatch the
// moment it finds a staged bundle whose metadata doesn't match what's
// actually running -- the ONE integrity check this whole update-bundle
// system exists to enforce. Before this fix, that catch block logged the
// error and called process.exit(76) with NOTHING rolled back, so the very
// next restart re-read the identical journal, hit the identical mismatch,
// and exited again -- forever. Worse: the LATER code that already knows how
// to roll a version_mismatch back (the ready-callback's own handling of
// acknowledgeUpdateBundle()'s failure, search index.js for
// "Update startup handshake failed") can never run for this exact
// condition, because this earlier check -- same journal, same
// runningMetadata, same comparison -- always throws first. The safety net
// that catches the exact problem it was built for was then getting
// permanently stuck instead of healing.
//
// This tests recoverFromStartupInspectionFailure() -- the extracted,
// exported function index.js's startup catch now calls -- directly against
// a REAL on-disk journal produced by the real stageUpdateBundle()/
// applyUpdateBundle() (not a mock), so this is proof the actual rollback
// mechanism runs, not just that some function was called.
function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function metadata(version = "2.0.0", buildSha = "new-build") {
  return { panelVersion: version, buildSha, apiContractVersion: 1 };
}

let installDir;

function prepareAppliedBundle() {
  const binaryPath = path.join(installDir, "ZomboidControlPanel");
  const stagedBinaryPath = `${binaryPath}.new`;
  const liveClientPath = path.join(installDir, "client", "dist");
  const incomingClientPath = path.join(installDir, "incoming-client");
  writeFile(binaryPath, "old-binary");
  writeFile(stagedBinaryPath, "new-binary");
  writeFile(path.join(liveClientPath, "index.html"), "old-client");
  writeFile(path.join(incomingClientPath, "index.html"), "new-client");
  writeFile(
    path.join(incomingClientPath, "build-info.json"),
    JSON.stringify(metadata()),
  );
  const journalPath = stageUpdateBundle({
    installDir,
    version: "2.0.0",
    binaryPath,
    stagedBinaryPath,
    liveClientPath,
    incomingClientPath,
    metadata: metadata(),
  });
  applyUpdateBundle(journalPath);
  return { binaryPath, liveClientPath, journalPath };
}

describe("recoverFromStartupInspectionFailure: the pre-listen version_mismatch catch actually rolls back", () => {
  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-startup-mismatch-"));
  });

  afterEach(() => {
    fs.rmSync(installDir, { recursive: true, force: true });
  });

  it("rolls the binary and client back to the pre-update artifacts on a real version_mismatch", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareAppliedBundle();
    const error = new Error("mismatch");
    error.code = "version_mismatch";

    recoverFromStartupInspectionFailure(error, journalPath);

    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it("does nothing for a different error code -- must not roll back an unrelated startup failure (e.g. a genuinely corrupt journal, which rollback cannot safely interpret)", () => {
    const { binaryPath, journalPath } = prepareAppliedBundle();
    const before = fs.readFileSync(binaryPath, "utf8");
    const error = new Error("corrupt");
    error.code = "invalid_bundle";

    recoverFromStartupInspectionFailure(error, journalPath);

    expect(fs.readFileSync(binaryPath, "utf8")).toBe(before);
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  it("does not throw when the journal is already gone (nothing to roll back)", () => {
    const journalPath = path.join(installDir, "update-bundle.json");
    const error = new Error("mismatch");
    error.code = "version_mismatch";

    expect(() => recoverFromStartupInspectionFailure(error, journalPath)).not.toThrow();
  });

  it("does not throw even if recoverInterruptedUpdateBundle itself throws -- logs instead, so the fatal process.exit(76) right after it still runs", () => {
    const { journalPath } = prepareAppliedBundle();
    // Corrupt the journal so recoverInterruptedUpdateBundle()'s own
    // readUpdateBundleJournalIfPresent() throws deterministically (invalid
    // JSON -> invalid_bundle) -- a reliable secondary failure to prove the
    // CALLER (index.js's fatal startup path) is protected from it,
    // regardless of exactly which way a real rollback can fail.
    fs.writeFileSync(journalPath, "{not valid json");
    const error = new Error("mismatch");
    error.code = "version_mismatch";

    expect(() => recoverFromStartupInspectionFailure(error, journalPath)).not.toThrow();
  });
});
