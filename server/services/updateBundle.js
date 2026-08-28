import crypto from "crypto";
import fs from "fs";
import path from "path";

export const PANEL_API_CONTRACT_VERSION = 1;

const JOURNAL_PHASES = new Set([
  "staged",
  "applying",
  "binary_backed_up",
  "client_backed_up",
  "client_activated",
  "awaiting_startup_ack",
  "rollback_failed",
  "rolled_back",
]);

const REQUIRED_JOURNAL_PATHS = [
  "binary",
  "stagedBinary",
  "backupBinary",
  "liveClient",
  "stagedClient",
  "backupClient",
];

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

function readJson(filePath, errorCode = "invalid_bundle") {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === errorCode) throw error;
    throw updateError(errorCode, `Could not read JSON from ${filePath}`, error);
  }
}

function renameIfPresent(source, destination) {
  try {
    fs.renameSync(source, destination);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function writeJournal(journalPath, journal) {
  const temporaryPath = `${journalPath}.tmp-${process.pid}`;
  const previousPath = `${journalPath}.previous`;
  fs.writeFileSync(temporaryPath, JSON.stringify(journal, null, 2), "utf8");
  fs.rmSync(previousPath, { force: true });
  renameIfPresent(journalPath, previousPath);
  try {
    fs.renameSync(temporaryPath, journalPath);
    fs.rmSync(previousPath, { force: true });
  } catch (error) {
    renameIfPresent(previousPath, journalPath);
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

function hasValidMetadata(value) {
  const metadata = normalizedMetadata(value);
  return (
    metadata.panelVersion !== "" &&
    metadata.buildSha !== "" &&
    Number.isInteger(metadata.apiContractVersion) &&
    metadata.apiContractVersion > 0
  );
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
  if (typeof installDir !== "string" || typeof candidate !== "string") {
    throw updateError("invalid_bundle", `${label} is not a valid path`);
  }
  const resolvedInstallDir = path.resolve(installDir);
  const root = `${resolvedInstallDir}${path.sep}`;
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedInstallDir && !resolved.startsWith(root)) {
    throw updateError("invalid_bundle", `${label} is outside the install directory`);
  }
  return resolved;
}

function validateJournal(journal, journalPath) {
  if (
    !journal ||
    journal.schemaVersion !== 1 ||
    typeof journal.transactionId !== "string" ||
    journal.transactionId === "" ||
    typeof journal.version !== "string" ||
    !JOURNAL_PHASES.has(journal.phase) ||
    typeof journal.installDir !== "string" ||
    !hasValidMetadata(journal.metadata) ||
    typeof journal.hashes?.binarySha256 !== "string" ||
    journal.hashes.binarySha256 === "" ||
    !journal.paths
  ) {
    throw updateError("invalid_bundle", "Update bundle journal is invalid");
  }

  const installDir = path.resolve(journal.installDir);
  if (path.dirname(path.resolve(journalPath)) !== installDir) {
    throw updateError(
      "invalid_bundle",
      "Update bundle journal does not match its installation directory",
    );
  }
  assertInsideInstall(installDir, journalPath, "journal");
  for (const label of REQUIRED_JOURNAL_PATHS) {
    assertInsideInstall(installDir, journal.paths[label], label);
  }
  return journal;
}

export function readUpdateBundleJournalIfPresent(journalPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(journalPath, "r");
    let journal;
    try {
      journal = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    } catch (error) {
      throw updateError("invalid_bundle", "Update bundle journal is not valid JSON", error);
    }
    return validateJournal(journal, journalPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "invalid_bundle") throw error;
    throw updateError("invalid_bundle", "Could not read update bundle journal", error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function markerIsPresent(markerPath, installDir) {
  if (!markerPath) return false;
  assertInsideInstall(installDir, markerPath, "applying marker");
  let descriptor;
  try {
    descriptor = fs.openSync(markerPath, "r");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw updateError("invalid_bundle", "Could not inspect update applying marker", error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ensureCompatibleBundle(journal, runningMetadata) {
  const backendCompatibility = validateBuildCompatibility(
    journal.metadata,
    runningMetadata,
  );
  const frontendCompatibility = validateBuildCompatibility(
    readJson(path.join(journal.paths.liveClient, "build-info.json")),
    runningMetadata,
  );
  if (!backendCompatibility.compatible || !frontendCompatibility.compatible) {
    throw updateError(
      "version_mismatch",
      "Applied frontend and backend metadata do not match",
    );
  }
}

function sameAcknowledgementState(previous, current) {
  return (
    previous.transactionId === current.transactionId &&
    previous.phase === current.phase &&
    previous.hashes.binarySha256 === current.hashes.binarySha256 &&
    validateBuildCompatibility(previous.metadata, current.metadata).compatible &&
    REQUIRED_JOURNAL_PATHS.every(
      (label) => previous.paths[label] === current.paths[label],
    )
  );
}

export function inspectPendingUpdateBundle({
  journalPath,
  applyingMarkerPath,
  runningMetadata,
}) {
  const journal = readUpdateBundleJournalIfPresent(journalPath);
  if (!journal) {
    return { pending: false, awaitingStartupAck: false };
  }

  const windowsApplication =
    journal.phase === "staged" &&
    markerIsPresent(applyingMarkerPath, journal.installDir);
  const awaitingStartupAck =
    journal.phase === "awaiting_startup_ack" || windowsApplication;

  if (awaitingStartupAck) ensureCompatibleBundle(journal, runningMetadata);

  return {
    pending: true,
    awaitingStartupAck,
    phase: journal.phase,
    transactionId: journal.transactionId,
    metadata: normalizedMetadata(journal.metadata),
    applyingMarkerPath,
  };
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

  let binarySha256;
  try {
    binarySha256 = sha256File(stagedBinaryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw updateError("av_quarantine", "Staged update binary is missing", error);
    }
    throw error;
  }
  let indexDescriptor;
  try {
    indexDescriptor = fs.openSync(path.join(incomingClientPath, "index.html"), "r");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw updateError(
        "frontend_swap_failed",
        "Staged frontend does not contain index.html",
        error,
      );
    }
    throw error;
  } finally {
    if (indexDescriptor !== undefined) fs.closeSync(indexDescriptor);
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
    hashes: { binarySha256 },
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
    const capturedBackup = `${backup}.restoring-${process.pid}`;
    try {
      fs.rmSync(capturedBackup, { recursive: isDirectory, force: true });
      if (!renameIfPresent(backup, capturedBackup)) return;
      try {
        fs.rmSync(live, { recursive: isDirectory, force: true });
        fs.renameSync(capturedBackup, live);
      } catch (error) {
        renameIfPresent(capturedBackup, backup);
        throw error;
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
  const journal = readUpdateBundleJournalIfPresent(journalPath);
  if (!journal) throw updateError("invalid_bundle", "Update bundle journal is missing");
  const { paths } = journal;
  let stagedBinaryHash;
  try {
    stagedBinaryHash = sha256File(paths.stagedBinary);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw updateError("av_quarantine", "Staged update binary is missing", error);
    }
    throw error;
  }
  if (stagedBinaryHash !== journal.hashes.binarySha256) {
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
    renameIfPresent(paths.binary, paths.backupBinary);
    journal.phase = "binary_backed_up";
    writeJournal(journalPath, journal);

    renameIfPresent(paths.liveClient, paths.backupClient);
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

export function acknowledgeUpdateBundle(
  journalPath,
  runningMetadata,
  { transactionId, expectedMetadata, applyingMarkerPath } = {},
) {
  const journal = readUpdateBundleJournalIfPresent(journalPath);
  if (!journal) return false;

  if (transactionId && journal.transactionId !== transactionId) {
    throw updateError(
      "invalid_bundle",
      "Update bundle transaction changed before startup acknowledgement",
    );
  }
  if (
    expectedMetadata &&
    !validateBuildCompatibility(journal.metadata, expectedMetadata).compatible
  ) {
    throw updateError(
      "invalid_bundle",
      "Update bundle metadata changed before startup acknowledgement",
    );
  }

  const windowsApplication =
    journal.phase === "staged" &&
    markerIsPresent(applyingMarkerPath, journal.installDir);
  if (journal.phase !== "awaiting_startup_ack" && !windowsApplication) return false;

  const confirmedJournal = readUpdateBundleJournalIfPresent(journalPath);
  if (!confirmedJournal) return false;
  if (!sameAcknowledgementState(journal, confirmedJournal)) {
    throw updateError(
      "invalid_bundle",
      "Update bundle state changed before startup acknowledgement",
    );
  }
  if (
    windowsApplication &&
    !markerIsPresent(applyingMarkerPath, confirmedJournal.installDir)
  ) {
    return false;
  }

  try {
    ensureCompatibleBundle(confirmedJournal, runningMetadata);
  } catch (error) {
    if (error?.code !== "version_mismatch") throw error;
    const rollbackErrors = rollback(
      journalPath,
      confirmedJournal,
      "version_mismatch",
    );
    if (!rollbackErrors.length && applyingMarkerPath) {
      fs.rmSync(applyingMarkerPath, { force: true });
    }
    throw error;
  }

  fs.rmSync(confirmedJournal.paths.backupBinary, { force: true });
  fs.rmSync(confirmedJournal.paths.backupClient, { recursive: true, force: true });
  fs.rmSync(journalPath, { force: true });
  if (applyingMarkerPath) fs.rmSync(applyingMarkerPath, { force: true });
  return true;
}

export function recoverInterruptedUpdateBundle(
  journalPath,
  reason = "startup_handshake_failed",
) {
  const journal = readUpdateBundleJournalIfPresent(journalPath);
  if (!journal) return false;
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
