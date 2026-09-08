import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  acknowledgeUpdateBundle,
  applyUpdateBundle,
  inspectPendingUpdateBundle,
  readUpdateBundleJournalIfPresent,
  recoverFromUnreadableJournal,
  recoverInterruptedUpdateBundle,
  stageUpdateBundle,
  validateBuildCompatibility,
} from "../services/updateBundle.js";

let installDir;

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function metadata(version = "2.0.0", buildSha = "new-build") {
  return { panelVersion: version, buildSha, apiContractVersion: 1 };
}

function prepareBundle() {
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
  const sentinelPath = path.join(installDir, "data", "db.json");
  writeFile(sentinelPath, "operator-state");
  const journalPath = stageUpdateBundle({
    installDir,
    version: "2.0.0",
    binaryPath,
    stagedBinaryPath,
    liveClientPath,
    incomingClientPath,
    metadata: metadata(),
  });
  return { binaryPath, stagedBinaryPath, liveClientPath, journalPath, sentinelPath };
}

function simulateWindowsApplication(journalPath) {
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  fs.renameSync(journal.paths.binary, journal.paths.backupBinary);
  fs.renameSync(journal.paths.liveClient, journal.paths.backupClient);
  fs.renameSync(journal.paths.stagedClient, journal.paths.liveClient);
  fs.renameSync(journal.paths.stagedBinary, journal.paths.binary);
  const applyingMarkerPath = path.join(installDir, ".update-applying");
  writeFile(applyingMarkerPath, "applying");
  return { journal, applyingMarkerPath };
}

describe("versioned panel update bundles", () => {
  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-update-bundle-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(installDir, { recursive: true, force: true });
  });

  it("stages matching frontend and backend artifacts without touching the live client", () => {
    const { liveClientPath, journalPath } = prepareBundle();

    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    expect(journal.phase).toBe("staged");
    expect(journal.metadata).toEqual(metadata());
    expect(fs.existsSync(path.join(journal.paths.stagedClient, "index.html"))).toBe(true);
  });

  // main-is-red, 2026-09-05: clientFiles exists purely so a genuine
  // clientSha256 disagreement on Windows can be compared, file by file,
  // against what Node actually hashed -- pins its shape and content so it
  // can't silently drift from what sha256Directory() really produces.
  it("records the per-file (path, hash) pairs it hashed alongside clientSha256", () => {
    const { journalPath } = prepareBundle();
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));

    expect(journal.hashes.clientFiles).toEqual([
      `build-info.json:${crypto.createHash("sha256").update(JSON.stringify(metadata())).digest("hex")}`,
      `index.html:${crypto.createHash("sha256").update("new-client").digest("hex")}`,
    ]);
  });

  it("retains both backups until the new backend acknowledges startup", () => {
    const { binaryPath, liveClientPath, journalPath, sentinelPath } = prepareBundle();

    applyUpdateBundle(journalPath);

    expect(fs.readFileSync(binaryPath, "utf8")).toBe("new-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "new-client",
    );
    expect(JSON.parse(fs.readFileSync(journalPath, "utf8")).phase).toBe(
      "awaiting_startup_ack",
    );

    acknowledgeUpdateBundle(journalPath, metadata());

    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("operator-state");
  });

  // main-is-red, 2026-09-05: a missing staged file means the check could
  // not run at all -- distinct from a genuine, computed hash mismatch
  // (the "tampered" test below), which is why this expects
  // hash_unverifiable now, not av_quarantine. Same distinction the Windows
  // side (build.js) already makes between UNVERIFIABLE and MISMATCH.
  it("rejects a missing staged binary before changing either live artifact", () => {
    const { stagedBinaryPath, binaryPath, liveClientPath, journalPath } = prepareBundle();
    fs.unlinkSync(stagedBinaryPath);

    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "hash_unverifiable" }),
    );
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });

  it("rejects a missing staged client bundle before changing either live artifact", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareBundle();
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    fs.rmSync(journal.paths.stagedClient, { recursive: true, force: true });

    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "hash_unverifiable" }),
    );
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });

  // main-is-red, 2026-09-05: the pre-fix code only special-cased ENOENT --
  // any OTHER read failure (permission denied, a mid-read I/O error) fell
  // through `throw error` completely unwrapped, with no .code an upstream
  // caller could recognize at all. This proves the fix covers that class
  // too, not just a rename of the ENOENT branch.
  it("wraps a non-ENOENT read failure (e.g. permission denied) as hash_unverifiable too, not a raw unstructured error", () => {
    const { stagedBinaryPath, journalPath } = prepareBundle();
    const originalReadFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
      if (filePath === stagedBinaryPath) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return originalReadFileSync(filePath, ...args);
    });

    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "hash_unverifiable" }),
    );
  });

  // 2026-09-05, client-bundle-integrity: the staged BINARY has always been
  // hash-verified before every apply -- the staged CLIENT bundle never was,
  // on either platform. A file corrupted in the same window Dwight measured
  // for the binary (staged, present under the right name, but no longer
  // matching what was staged) passed straight through and got activated.
  it("rejects a staged client bundle whose content no longer matches what was staged, before changing either live artifact", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareBundle();
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    fs.writeFileSync(
      path.join(journal.paths.stagedClient, "index.html"),
      "tampered-client",
    );

    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "av_quarantine" }),
    );
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });

  it("rolls back the frontend when binary activation fails", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareBundle();
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(source).endsWith(".new") && destination === binaryPath) {
        throw Object.assign(new Error("simulated binary swap failure"), { code: "EIO" });
      }
      return originalRename(source, destination);
    });

    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "binary_swap_failed" }),
    );
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });

  it("restores the binary when frontend activation fails", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareBundle();
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (source === journal.paths.stagedClient && destination === liveClientPath) {
        throw Object.assign(new Error("simulated frontend swap failure"), { code: "EIO" });
      }
      return originalRename(source, destination);
    });

    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "frontend_swap_failed" }),
    );
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });

  it("recovers both artifacts from an interrupted awaiting-ack transaction", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareBundle();
    applyUpdateBundle(journalPath);

    recoverInterruptedUpdateBundle(journalPath, "startup_handshake_failed");

    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });

  it("detects frontend-older and backend-older mismatches", () => {
    expect(
      validateBuildCompatibility(metadata("1.9.0"), metadata("2.0.0")),
    ).toEqual(
      expect.objectContaining({
        compatible: false,
        diagnosticCode: "version_mismatch",
      }),
    );
    expect(
      validateBuildCompatibility(metadata("2.1.0"), metadata("2.0.0")),
    ).toEqual(
      expect.objectContaining({
        compatible: false,
        diagnosticCode: "version_mismatch",
      }),
    );
  });

  it("rolls back both artifacts when the new backend acknowledges with mismatched metadata", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareBundle();
    applyUpdateBundle(journalPath);

    expect(() =>
      acknowledgeUpdateBundle(journalPath, metadata("2.0.1", "other-build")),
    ).toThrowError(expect.objectContaining({ code: "version_mismatch" }));

    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });

  it("treats a journal missing at open time as no pending update", () => {
    const journalPath = path.join(installDir, "update-bundle.json");
    const originalOpen = fs.openSync.bind(fs);
    vi.spyOn(fs, "openSync").mockImplementation((candidate, ...args) => {
      if (candidate === journalPath) {
        throw Object.assign(new Error("journal disappeared"), { code: "ENOENT" });
      }
      return originalOpen(candidate, ...args);
    });

    expect(readUpdateBundleJournalIfPresent(journalPath)).toBeNull();
    expect(
      inspectPendingUpdateBundle({
        journalPath,
        applyingMarkerPath: path.join(installDir, ".update-applying"),
        runningMetadata: metadata(),
      }),
    ).toEqual(expect.objectContaining({ pending: false }));
  });

  it("fails closed for a corrupt update journal", () => {
    const journalPath = path.join(installDir, "update-bundle.json");
    writeFile(journalPath, "{not-json");

    expect(() =>
      inspectPendingUpdateBundle({
        journalPath,
        applyingMarkerPath: path.join(installDir, ".update-applying"),
        runningMetadata: metadata(),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_bundle" }));
  });

  it("rejects journal paths outside the installation directory", () => {
    const { journalPath } = prepareBundle();
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    journal.paths.liveClient = path.join(path.dirname(installDir), "escaped-client");
    fs.writeFileSync(journalPath, JSON.stringify(journal), "utf8");

    expect(() =>
      inspectPendingUpdateBundle({
        journalPath,
        applyingMarkerPath: path.join(installDir, ".update-applying"),
        runningMetadata: metadata(),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_bundle" }));
  });

  it("recognizes staged plus the Windows applying marker without rewriting the journal", () => {
    const { journalPath } = prepareBundle();
    const { journal, applyingMarkerPath } = simulateWindowsApplication(journalPath);
    const originalJournal = fs.readFileSync(journalPath, "utf8");

    const inspection = inspectPendingUpdateBundle({
      journalPath,
      applyingMarkerPath,
      runningMetadata: metadata(),
    });

    expect(inspection).toEqual(
      expect.objectContaining({
        pending: true,
        awaitingStartupAck: true,
        transactionId: journal.transactionId,
      }),
    );
    expect(fs.readFileSync(journalPath, "utf8")).toBe(originalJournal);
    expect(JSON.parse(originalJournal).phase).toBe("staged");
  });

  it("keeps backups when the Windows applying marker disappears before acknowledgement", () => {
    const { journalPath } = prepareBundle();
    const { journal, applyingMarkerPath } = simulateWindowsApplication(journalPath);
    const inspection = inspectPendingUpdateBundle({
      journalPath,
      applyingMarkerPath,
      runningMetadata: metadata(),
    });
    fs.unlinkSync(applyingMarkerPath);

    expect(
      acknowledgeUpdateBundle(journalPath, metadata(), {
        transactionId: inspection.transactionId,
        applyingMarkerPath,
      }),
    ).toBe(false);
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(fs.existsSync(journal.paths.backupBinary)).toBe(true);
    expect(fs.existsSync(journal.paths.backupClient)).toBe(true);
  });

  it("keeps backups when the journal transaction changes before acknowledgement", () => {
    const { journalPath } = prepareBundle();
    const { journal, applyingMarkerPath } = simulateWindowsApplication(journalPath);
    const inspection = inspectPendingUpdateBundle({
      journalPath,
      applyingMarkerPath,
      runningMetadata: metadata(),
    });
    const replacement = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    replacement.transactionId = "replacement-transaction";
    fs.writeFileSync(journalPath, JSON.stringify(replacement), "utf8");

    expect(() =>
      acknowledgeUpdateBundle(journalPath, metadata(), {
        transactionId: inspection.transactionId,
        applyingMarkerPath,
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_bundle" }));
    expect(fs.existsSync(journal.paths.backupBinary)).toBe(true);
    expect(fs.existsSync(journal.paths.backupClient)).toBe(true);
  });

  it("acknowledges a matching Windows bundle and removes both backups and its marker", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareBundle();
    const { journal, applyingMarkerPath } = simulateWindowsApplication(journalPath);
    const inspection = inspectPendingUpdateBundle({
      journalPath,
      applyingMarkerPath,
      runningMetadata: metadata(),
    });

    expect(
      acknowledgeUpdateBundle(journalPath, metadata(), {
        transactionId: inspection.transactionId,
        applyingMarkerPath,
      }),
    ).toBe(true);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("new-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "new-client",
    );
    expect(fs.existsSync(journal.paths.backupBinary)).toBe(false);
    expect(fs.existsSync(journal.paths.backupClient)).toBe(false);
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.existsSync(applyingMarkerPath)).toBe(false);
  });

  it("rolls back both Windows artifacts when metadata changes before acknowledgement", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareBundle();
    const { applyingMarkerPath } = simulateWindowsApplication(journalPath);
    const inspection = inspectPendingUpdateBundle({
      journalPath,
      applyingMarkerPath,
      runningMetadata: metadata(),
    });
    fs.writeFileSync(
      path.join(liveClientPath, "build-info.json"),
      JSON.stringify(metadata("2.0.1", "unexpected-build")),
      "utf8",
    );

    expect(() =>
      acknowledgeUpdateBundle(journalPath, metadata(), {
        transactionId: inspection.transactionId,
        applyingMarkerPath,
      }),
    ).toThrowError(expect.objectContaining({ code: "version_mismatch" }));
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });
});

// Hotfix, 2026-09-07 ("hotfix-invalid-bundle"): recoverInterruptedUpdateBundle()
// needs a readable journal to know what to roll back to -- it re-reads the
// same journalPath as its first step, so it cannot help when the journal
// ITSELF is what's corrupt (unparseable JSON, structurally invalid, an
// installDir that no longer matches where the journal actually lives). A
// real v1.2.16 user hit exactly this and was stuck at exit code 76 forever,
// on every restart, because nothing before this fix ever cleaned up an
// unreadable journal. recoverFromUnreadableJournal() is the fallback: it
// cannot ask the journal what to restore, so it restores from the FIXED
// backup locations stageUpdateBundle() always writes
// (`<binary>.bundle-previous`, `dist.previous` next to the live client),
// then moves the corrupt journal aside (renamed, not deleted) so it can
// never again be the reason startup refuses forever.
describe("recoverFromUnreadableJournal: fixed-location recovery when the journal itself can't be trusted", () => {
  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-unreadable-journal-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(installDir, { recursive: true, force: true });
  });

  it("restores the binary and client from their bundle-previous/dist.previous backups, and quarantines (not deletes) the corrupt journal", () => {
    const binaryPath = path.join(installDir, "ZomboidControlPanel");
    const liveClientPath = path.join(installDir, "client", "dist");
    const journalPath = path.join(installDir, "update-bundle.json");
    writeFile(binaryPath, "half-applied-binary");
    writeFile(`${binaryPath}.bundle-previous`, "previous-working-binary");
    writeFile(path.join(liveClientPath, "index.html"), "half-applied-client");
    writeFile(
      path.join(path.dirname(liveClientPath), "dist.previous", "index.html"),
      "previous-working-client",
    );
    writeFile(journalPath, "{not valid json");
    const applyingMarkerPath = path.join(installDir, ".update-applying");
    writeFile(applyingMarkerPath, "applying");

    const outcome = recoverFromUnreadableJournal({
      journalPath,
      binaryPath,
      liveClientPath,
    });

    expect(outcome.restoredBinary).toBe(true);
    expect(outcome.restoredClient).toBe(true);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("previous-working-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "previous-working-client",
    );
    // Quarantined, not gone -- the evidence survives for investigation.
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(outcome.quarantinedJournalPath).not.toBeNull();
    expect(fs.existsSync(outcome.quarantinedJournalPath)).toBe(true);
    expect(fs.readFileSync(outcome.quarantinedJournalPath, "utf8")).toBe(
      "{not valid json",
    );
    // Orphaned once its journal is gone -- nothing left to reference it.
    expect(fs.existsSync(applyingMarkerPath)).toBe(false);
  });

  it("quarantines the journal even when neither backup exists -- nothing was actually pending, the journal is just garbage", () => {
    const binaryPath = path.join(installDir, "ZomboidControlPanel");
    const liveClientPath = path.join(installDir, "client", "dist");
    const journalPath = path.join(installDir, "update-bundle.json");
    writeFile(binaryPath, "current-binary");
    writeFile(path.join(liveClientPath, "index.html"), "current-client");
    writeFile(journalPath, "{not valid json");

    const outcome = recoverFromUnreadableJournal({
      journalPath,
      binaryPath,
      liveClientPath,
    });

    expect(outcome.restoredBinary).toBe(false);
    expect(outcome.restoredClient).toBe(false);
    // Untouched -- nothing to restore from, so nothing was touched.
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("current-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "current-client",
    );
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.existsSync(outcome.quarantinedJournalPath)).toBe(true);
  });

  it("throws an actionable rollback_failed, and leaves the journal in place, if the binary backup exists but can't be activated", () => {
    const binaryPath = path.join(installDir, "ZomboidControlPanel");
    const backupBinaryPath = `${binaryPath}.bundle-previous`;
    const liveClientPath = path.join(installDir, "client", "dist");
    const journalPath = path.join(installDir, "update-bundle.json");
    writeFile(binaryPath, "half-applied-binary");
    writeFile(backupBinaryPath, "previous-working-binary");
    writeFile(journalPath, "{not valid json");

    const capturedPath = `${backupBinaryPath}.restoring-${process.pid}`;
    const realRenameSync = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((src, dest) => {
      if (src === capturedPath && dest === binaryPath) {
        throw new Error("simulated EBUSY: file in use");
      }
      return realRenameSync(src, dest);
    });

    expect(() =>
      recoverFromUnreadableJournal({ journalPath, binaryPath, liveClientPath }),
    ).toThrowError(
      expect.objectContaining({
        code: "rollback_failed",
        message: expect.stringContaining(backupBinaryPath),
      }),
    );
    // Bailed before touching the journal -- the manual-recovery fallback
    // this throws to the caller still names an exact, still-present path.
    expect(fs.existsSync(journalPath)).toBe(true);
    // The failed activation attempt must not have lost the backup either.
    expect(fs.existsSync(backupBinaryPath)).toBe(true);
  });
});

// GH#149, 2026-09-08 (god-verified root cause, reported by a user named
// Burnjack): f69c2f7f added journal.hashes.clientSha256 as a REQUIRED field
// (main-is-red, 2026-09-05, client-bundle-integrity) without bumping
// schemaVersion. Any journal staged by a pre-f69c2f7f binary -- confirmed
// via `git show v1.2.15:server/services/updateBundle.js`, NOT from memory --
// writes `hashes: { binarySha256 }` only, still under schemaVersion: 1. The
// OLD binary writes the journal; the NEW binary reads it after the restart.
// That made every v1.2.15-or-earlier install permanently, deterministically
// unable to update in-app: the swap itself succeeds, the new binary boots,
// calls inspectPendingPanelUpdate() -> validateJournal(), and throws
// invalid_bundle on a perfectly valid legacy journal, every single time --
// re-downloading can never help, since the OLD binary reproduces the
// identical legacy-shaped journal on every attempt.
describe("GH#149: a legacy schema-1 journal (no clientSha256, exactly what v1.2.15 staged) must not brick the update", () => {
  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-legacy-journal-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(installDir, { recursive: true, force: true });
  });

  // Fixture shape lifted directly from `git show v1.2.15:server/services/updateBundle.js`'s
  // own stageUpdateBundle() -- schemaVersion: 1, hashes: { binarySha256 }
  // only, same paths/phase shape as today. Not constructed from memory of
  // what "legacy" might have looked like.
  function prepareLegacyBundle() {
    const binaryPath = path.join(installDir, "ZomboidControlPanel");
    const stagedBinaryPath = `${binaryPath}.new`;
    const liveClientPath = path.join(installDir, "client", "dist");
    const stagedClientPath = path.join(installDir, "client", "dist.new-2.0.0");
    const backupBinaryPath = `${binaryPath}.bundle-previous`;
    const backupClientPath = path.join(installDir, "client", "dist.previous");
    const journalPath = path.join(installDir, "update-bundle.json");

    writeFile(binaryPath, "old-binary");
    writeFile(stagedBinaryPath, "new-binary");
    writeFile(path.join(liveClientPath, "index.html"), "old-client");
    writeFile(path.join(liveClientPath, "build-info.json"), JSON.stringify(metadata()));
    writeFile(path.join(stagedClientPath, "index.html"), "new-client");
    writeFile(path.join(stagedClientPath, "build-info.json"), JSON.stringify(metadata()));

    const resolvedInstallDir = path.resolve(installDir);
    const journal = {
      schemaVersion: 1,
      transactionId: crypto.randomUUID(),
      version: "2.0.0",
      phase: "staged",
      stagedAt: new Date().toISOString(),
      installDir: resolvedInstallDir,
      metadata: metadata(),
      hashes: { binarySha256: crypto.createHash("sha256").update("new-binary").digest("hex") },
      paths: {
        binary: path.resolve(binaryPath),
        stagedBinary: path.resolve(stagedBinaryPath),
        backupBinary: path.resolve(backupBinaryPath),
        liveClient: path.resolve(liveClientPath),
        stagedClient: path.resolve(stagedClientPath),
        backupClient: path.resolve(backupClientPath),
      },
    };
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf8");
    return { binaryPath, stagedBinaryPath, liveClientPath, journalPath, journal };
  }

  it("readUpdateBundleJournalIfPresent() accepts the legacy shape instead of throwing invalid_bundle", () => {
    const { journalPath } = prepareLegacyBundle();

    expect(() => readUpdateBundleJournalIfPresent(journalPath)).not.toThrow();
    expect(readUpdateBundleJournalIfPresent(journalPath).schemaVersion).toBe(1);
  });

  // The literal GH#149 reproduction: the Windows swap has already succeeded
  // (real files renamed in place, exactly like simulateWindowsApplication()
  // above), the applying marker is present, and this is the moment the new
  // binary calls inspectPendingPanelUpdate() on startup. Before the fix,
  // this threw invalid_bundle here -- exit 76, automatic rollback, the
  // exact supervisor.log shape from the original report.
  it("inspectPendingUpdateBundle() reaches awaitingStartupAck on a legacy journal after a real Windows-style swap, instead of throwing", () => {
    const { journalPath, journal } = prepareLegacyBundle();
    fs.renameSync(journal.paths.binary, journal.paths.backupBinary);
    fs.renameSync(journal.paths.liveClient, journal.paths.backupClient);
    fs.renameSync(journal.paths.stagedClient, journal.paths.liveClient);
    fs.renameSync(journal.paths.stagedBinary, journal.paths.binary);
    const applyingMarkerPath = path.join(installDir, ".update-applying");
    writeFile(applyingMarkerPath, "applying");

    const inspection = inspectPendingUpdateBundle({
      journalPath,
      applyingMarkerPath,
      runningMetadata: metadata(),
    });

    expect(inspection).toEqual(
      expect.objectContaining({ pending: true, awaitingStartupAck: true }),
    );
  });

  // Proves the gate from BOTH directions: a legacy journal that never had a
  // client hash to compare against still applies cleanly (schema-1 skips
  // the check entirely, exactly as safe as v1.2.15's own apply path, which
  // never ran this check either) -- and the binary hash check, which every
  // schema has always had, still runs and still fails closed.
  it("applyUpdateBundle() on a legacy journal skips the (nonexistent) client-hash check but still verifies the binary hash", () => {
    const { binaryPath, liveClientPath, journalPath } = prepareLegacyBundle();

    expect(() => applyUpdateBundle(journalPath)).not.toThrow();
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("new-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "new-client",
    );
  });

  it("applyUpdateBundle() on a legacy journal still rejects a tampered staged binary (the one hash schema-1 always had)", () => {
    const { stagedBinaryPath, binaryPath, liveClientPath, journalPath } = prepareLegacyBundle();
    fs.writeFileSync(stagedBinaryPath, "tampered-binary");

    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "av_quarantine" }),
    );
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8")).toBe(
      "old-client",
    );
  });

  it("a schema-2 (current) journal still gets the full client-hash check -- the legacy bypass does not leak into current journals", () => {
    const { journalPath } = prepareBundle();
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    expect(journal.schemaVersion).toBe(2);
    fs.writeFileSync(
      path.join(journal.paths.stagedClient, "index.html"),
      "tampered-client",
    );

    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "av_quarantine" }),
    );
  });

  // God's own regression on the first pass, found and corrected same night:
  // `git show v1.2.16:server/services/updateBundle.js` and
  // `git show v1.2.20:server/services/updateBundle.js` both write
  // `schemaVersion: 1` -- SAME AS v1.2.15 -- but WITH a real, valid
  // clientSha256 (f69c2f7f added the field without bumping the schema, which
  // is the whole root cause). A gate keyed on schemaVersion === 2 could not
  // tell that shape apart from a genuine v1.2.15 legacy journal, and would
  // silently skip verifying the client bundle for the entire v1.2.16-v1.2.20
  // install base -- the majority of real users, not the v1.2.15 minority
  // this fix targets. The gate must key on the hash actually being present,
  // not on the schema number.
  //
  // Fixture built from the REAL current stageUpdateBundle() (so clientSha256
  // is a genuine, correctly-computed hash of the actual staged directory,
  // not hand-typed), with only schemaVersion patched down to 1 afterward --
  // exactly the shape v1.2.16-v1.2.20 actually wrote (schema 1, real hash),
  // not reconstructed by hand.
  it("GH#149 regression: a schema-1 journal that DOES carry a real clientSha256 (the actual v1.2.16-v1.2.20 shape) still catches a tampered client dist", () => {
    const { journalPath } = prepareBundle();
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    expect(typeof journal.hashes.clientSha256).toBe("string");
    expect(journal.hashes.clientSha256).not.toBe("");
    journal.schemaVersion = 1;
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf8");

    fs.writeFileSync(
      path.join(journal.paths.stagedClient, "index.html"),
      "tampered-client",
    );

    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "av_quarantine" }),
    );
  });
});
