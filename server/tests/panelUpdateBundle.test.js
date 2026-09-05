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
