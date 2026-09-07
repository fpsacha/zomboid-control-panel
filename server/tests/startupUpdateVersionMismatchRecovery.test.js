import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { recoverFromStartupInspectionFailure } from "../index.js";
import {
  applyUpdateBundle,
  inspectPendingUpdateBundle,
  stageUpdateBundle,
} from "../services/updateBundle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  it("does nothing for an unrelated error code -- must not roll back a startup failure this function doesn't understand", () => {
    const { binaryPath, journalPath } = prepareAppliedBundle();
    const before = fs.readFileSync(binaryPath, "utf8");
    const error = new Error("some other startup failure");
    error.code = "hash_unverifiable";

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

// Hotfix, 2026-09-07 ("hotfix-invalid-bundle"): a real v1.2.16 user
// (Charon, via Discord) updated and could not start the panel at all --
// "Update startup validation failed [invalid_bundle]: Update bundle
// journal is invalid. Panel exited with code 76", forever, on every
// restart. invalid_bundle is thrown from roughly ten sites in
// updateBundle.js and, before this fix, fell straight through
// recoverFromStartupInspectionFailure() (which only understood
// version_mismatch) to a bare process.exit(76) with nothing ever cleaned
// up. These tests cover both shapes invalid_bundle actually arrives in:
// a journal that's still readable (something ELSE it points at was bad --
// treated the same as version_mismatch, since the journal still knows what
// to roll back to), and a journal that is itself the corrupt thing (falls
// back to recoverFromUnreadableJournal()'s fixed-location recovery).
describe("recoverFromStartupInspectionFailure: invalid_bundle no longer gets stuck forever", () => {
  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-startup-invalid-bundle-"));
  });

  afterEach(() => {
    fs.rmSync(installDir, { recursive: true, force: true });
  });

  it("rolls back a still-readable journal for invalid_bundle exactly like version_mismatch -- the journal knows what to restore even though something ELSE about it was invalid", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareAppliedBundle();
    const error = new Error("Applied frontend build-info.json could not be read");
    error.code = "invalid_bundle";

    recoverFromStartupInspectionFailure(error, journalPath);

    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it("recovers from a genuinely unreadable journal by restoring the previous binary/client from their fixed-location backups and quarantining the journal, so the next startup no longer trips over it", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareAppliedBundle();
    // Simulate the journal itself going bad post-apply (the shape Charon
    // hit) -- overwrite the well-formed journal stageUpdateBundle/
    // applyUpdateBundle produced with garbage, while the real backups
    // those calls already wrote (<binary>.bundle-previous, dist.previous)
    // stay right where they are on disk.
    fs.writeFileSync(journalPath, "{not valid json");
    const error = new Error("Update bundle journal is not valid JSON");
    error.code = "invalid_bundle";

    // recoverFromUnreadableJournal's fallback derives binaryPath/liveClientPath
    // from panelUpdateChecker.getExeBasePath() (= process.execPath, minus
    // any .new/.new2 suffix) -- the SAME derivation stageUpdateBundle() used
    // when it originally wrote these fixed-location backups in production.
    // Point process.execPath at this test's fixture binary for the duration
    // of the call so the fallback looks in the same place this fixture
    // actually put the backups, then restore it.
    const realExecPath = process.execPath;
    process.execPath = binaryPath;
    try {
      recoverFromStartupInspectionFailure(error, journalPath);
    } finally {
      process.execPath = realExecPath;
    }

    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
    // Not just gone -- quarantined under a new name, so the evidence
    // survives; and crucially, the ORIGINAL journalPath no longer exists,
    // so a fresh inspection on the next restart is no longer pending.
    expect(fs.existsSync(journalPath)).toBe(false);
    const siblings = fs.readdirSync(installDir);
    expect(siblings.some((name) => name.startsWith("update-bundle.json.corrupt-"))).toBe(
      true,
    );
  });

  it("after recovering from an unreadable journal, the NEXT startup inspection sees no pending update at all -- this is the fix for 'every restart re-hits it forever'", () => {
    const { journalPath } = prepareAppliedBundle();
    fs.writeFileSync(journalPath, "{not valid json");
    const error = new Error("Update bundle journal is not valid JSON");
    error.code = "invalid_bundle";

    recoverFromStartupInspectionFailure(error, journalPath);

    const nextInspection = inspectPendingUpdateBundle({
      journalPath,
      applyingMarkerPath: path.join(installDir, ".update-applying"),
      runningMetadata: metadata(),
    });
    expect(nextInspection).toEqual({ pending: false, awaitingStartupAck: false });
  });

  it("quarantines an unreadable journal even with no backups present, and does not throw", () => {
    const journalPath = path.join(installDir, "update-bundle.json");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(journalPath, "{not valid json");
    const error = new Error("Update bundle journal is not valid JSON");
    error.code = "invalid_bundle";

    expect(() => recoverFromStartupInspectionFailure(error, journalPath)).not.toThrow();
    expect(fs.existsSync(journalPath)).toBe(false);
  });
});

// Log-adequacy follow-up, 2026-09-07 (god's dispatch): a log-only failure
// path (nothing before httpServer.listen() has an HTTP client to report
// through) IS the whole interface for that failure -- generic
// error.message with no file path is not an interface, it's a symptom
// description. Both of index.js's fatal update-startup catches now include
// the journal path in the log line itself. start() isn't decomposable for
// a real execution test (it boots the actual server), so this is a
// textual regression guard on the source instead of a mocked-log
// assertion -- cheap, and it fails immediately if a future edit to either
// message drops the path again, the same way errorCodeRegistry.test.js's
// own literal-scanning checks are textual rather than behavioral by
// necessity.
describe("startup update-failure log messages name the journal file to act on", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

  it("the pre-listen 'Update startup validation failed' catch includes the journal path", () => {
    const match = indexSource.match(
      /`Update startup validation failed \[[\s\S]{0,200}?`/,
    );
    expect(match).not.toBeNull();
    expect(match[0]).toContain("journalPath");
  });

  it("the post-listen 'Update startup handshake failed' catch includes the journal path", () => {
    const match = indexSource.match(
      /`Update startup handshake failed \[[\s\S]{0,200}?`/,
    );
    expect(match).not.toBeNull();
    expect(match[0]).toContain("updateBundleJournalPath()");
  });
});
