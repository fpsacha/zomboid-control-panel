import crypto from "crypto";
import fs from "fs";
import path from "path";

export const PANEL_API_CONTRACT_VERSION = 1;

function updateError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJournal(journalPath, journal) {
  const temporaryPath = `${journalPath}.tmp-${process.pid}`;
  const previousPath = `${journalPath}.previous`;
  fs.writeFileSync(temporaryPath, JSON.stringify(journal, null, 2), "utf8");
  fs.rmSync(previousPath, { force: true });
  if (fs.existsSync(journalPath)) fs.renameSync(journalPath, previousPath);
  try {
    fs.renameSync(temporaryPath, journalPath);
    fs.rmSync(previousPath, { force: true });
  } catch (error) {
    if (!fs.existsSync(journalPath) && fs.existsSync(previousPath)) {
      fs.renameSync(previousPath, journalPath);
    }
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function normalizedMetadata(value) {
  return {
    panelVersion: String(value?.panelVersion || ""),
    buildSha: String(value?.buildSha || ""),
    apiContractVersion: Number(value?.apiContractVersion),
  };
}

export function validateBuildCompatibility(frontend, backend) {
  const client = normalizedMetadata(frontend);
  const server = normalizedMetadata(backend);
  const compatible =
    client.panelVersion !== "" &&
    client.panelVersion === server.panelVersion &&
    client.buildSha !== "" &&
    client.buildSha === server.buildSha &&
    client.apiContractVersion === server.apiContractVersion;
  return compatible
    ? { compatible: true }
    : {
        compatible: false,
        diagnosticCode: "version_mismatch",
        reason: "Frontend and backend build metadata do not match.",
      };
}

function assertInsideInstall(installDir, candidate, label) {
  const root = `${path.resolve(installDir)}${path.sep}`;
  const resolved = path.resolve(candidate);
  if (resolved !== path.resolve(installDir) && !resolved.startsWith(root)) {
    throw updateError("invalid_bundle", `${label} is outside the install directory`);
  }
  return resolved;
}

function validateJournal(journal) {
  if (!journal || journal.schemaVersion !== 1 || !journal.paths) {
    throw updateError("invalid_bundle", "Update bundle journal is invalid");
  }
  for (const [label, candidate] of Object.entries(journal.paths)) {
    assertInsideInstall(journal.installDir, candidate, label);
  }
}

export function stageUpdateBundle({
  installDir,
  version,
  binaryPath,
  stagedBinaryPath,
  liveClientPath,
  incomingClientPath,
  metadata,
}) {
  const expectedMetadata = normalizedMetadata(metadata);
  const compatibility = validateBuildCompatibility(
    readJson(path.join(incomingClientPath, "build-info.json")),
    expectedMetadata,
  );
  if (!compatibility.compatible) {
    throw updateError(compatibility.diagnosticCode, compatibility.reason);
  }
  if (!fs.existsSync(stagedBinaryPath)) {
    throw updateError("av_quarantine", "Staged update binary is missing");
  }
  if (!fs.existsSync(path.join(incomingClientPath, "index.html"))) {
    throw updateError(
      "frontend_swap_failed",
      "Staged frontend does not contain index.html",
    );
  }

  const resolvedInstallDir = path.resolve(installDir);
  const safeVersion = String(version).replace(/[^0-9A-Za-z._-]/g, "-");
  const stagedClientPath = path.join(
    resolvedInstallDir,
    "client",
    `dist.new-${safeVersion}`,
  );
  const backupBinaryPath = `${binaryPath}.bundle-previous`;
  const backupClientPath = path.join(
    path.dirname(liveClientPath),
    "dist.previous",
  );
  const journalPath = path.join(resolvedInstallDir, "update-bundle.json");

  for (const [label, candidate] of Object.entries({
    binaryPath,
    stagedBinaryPath,
    liveClientPath,
    incomingClientPath,
    stagedClientPath,
    backupBinaryPath,
    backupClientPath,
  })) {
    assertInsideInstall(resolvedInstallDir, candidate, label);
  }

  fs.rmSync(stagedClientPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(stagedClientPath), { recursive: true });
  fs.cpSync(incomingClientPath, stagedClientPath, { recursive: true });

  const journal = {
    schemaVersion: 1,
    transactionId: crypto.randomUUID(),
    version: String(version),
    phase: "staged",
    stagedAt: new Date().toISOString(),
    installDir: resolvedInstallDir,
    metadata: expectedMetadata,
    hashes: { binarySha256: sha256File(stagedBinaryPath) },
    paths: {
      binary: path.resolve(binaryPath),
      stagedBinary: path.resolve(stagedBinaryPath),
      backupBinary: path.resolve(backupBinaryPath),
      liveClient: path.resolve(liveClientPath),
      stagedClient: path.resolve(stagedClientPath),
      backupClient: path.resolve(backupClientPath),
    },
  };
  writeJournal(journalPath, journal);
  return journalPath;
}

function rollback(journalPath, journal, reason) {
  const { paths } = journal;
  const rollbackErrors = [];
  const restore = (live, backup, isDirectory) => {
    try {
      if (fs.existsSync(backup)) {
        fs.rmSync(live, { recursive: isDirectory, force: true });
        fs.renameSync(backup, live);
      }
    } catch (error) {
      rollbackErrors.push(error.message);
    }
  };
  restore(paths.binary, paths.backupBinary, false);
  restore(paths.liveClient, paths.backupClient, true);
  journal.phase = rollbackErrors.length ? "rollback_failed" : "rolled_back";
  journal.failureCode = reason;
  journal.rollbackErrors = rollbackErrors;
  writeJournal(journalPath, journal);
  if (!rollbackErrors.length) fs.rmSync(journalPath, { force: true });
  return rollbackErrors;
}

export function applyUpdateBundle(journalPath) {
  const journal = readJson(journalPath);
  validateJournal(journal);
  const { paths } = journal;
  if (!fs.existsSync(paths.stagedBinary)) {
    throw updateError("av_quarantine", "Staged update binary is missing");
  }
  if (sha256File(paths.stagedBinary) !== journal.hashes.binarySha256) {
    throw updateError("av_quarantine", "Staged update binary hash changed");
  }
  const clientCompatibility = validateBuildCompatibility(
    readJson(path.join(paths.stagedClient, "build-info.json")),
    journal.metadata,
  );
  if (!clientCompatibility.compatible) {
    throw updateError(
      clientCompatibility.diagnosticCode,
      clientCompatibility.reason,
    );
  }

  fs.rmSync(paths.backupBinary, { force: true });
  fs.rmSync(paths.backupClient, { recursive: true, force: true });
  journal.phase = "applying";
  writeJournal(journalPath, journal);

  try {
    if (fs.existsSync(paths.binary)) fs.renameSync(paths.binary, paths.backupBinary);
    journal.phase = "binary_backed_up";
    writeJournal(journalPath, journal);

    if (fs.existsSync(paths.liveClient)) {
      fs.renameSync(paths.liveClient, paths.backupClient);
    }
    journal.phase = "client_backed_up";
    writeJournal(journalPath, journal);

    try {
      fs.renameSync(paths.stagedClient, paths.liveClient);
    } catch (error) {
      throw updateError("frontend_swap_failed", "Could not activate staged frontend", error);
    }
    journal.phase = "client_activated";
    writeJournal(journalPath, journal);

    try {
      fs.renameSync(paths.stagedBinary, paths.binary);
    } catch (error) {
      throw updateError("binary_swap_failed", "Could not activate staged binary", error);
    }
    journal.phase = "awaiting_startup_ack";
    journal.appliedAt = new Date().toISOString();
    writeJournal(journalPath, journal);
    return journal;
  } catch (error) {
    const code = error.code || "bundle_apply_failed";
    rollback(journalPath, journal, code);
    throw error;
  }
}

export function acknowledgeUpdateBundle(journalPath, runningMetadata) {
  if (!fs.existsSync(journalPath)) return false;
  const journal = readJson(journalPath);
  validateJournal(journal);
  if (journal.phase !== "awaiting_startup_ack") return false;
  const backendCompatibility = validateBuildCompatibility(
    journal.metadata,
    runningMetadata,
  );
  const frontendCompatibility = validateBuildCompatibility(
    readJson(path.join(journal.paths.liveClient, "build-info.json")),
    runningMetadata,
  );
  if (!backendCompatibility.compatible || !frontendCompatibility.compatible) {
    rollback(journalPath, journal, "version_mismatch");
    throw updateError(
      "version_mismatch",
      "Applied frontend and backend metadata do not match",
    );
  }
  fs.rmSync(journal.paths.backupBinary, { force: true });
  fs.rmSync(journal.paths.backupClient, { recursive: true, force: true });
  fs.rmSync(journalPath, { force: true });
  return true;
}

export function recoverInterruptedUpdateBundle(
  journalPath,
  reason = "startup_handshake_failed",
) {
  if (!fs.existsSync(journalPath)) return false;
  const journal = readJson(journalPath);
  validateJournal(journal);
  if (journal.phase === "staged") return false;
  const errors = rollback(journalPath, journal, reason);
  if (errors.length) {
    throw updateError(
      "rollback_failed",
      `Update rollback was incomplete: ${errors.join(", ")}`,
    );
  }
  return true;
}
