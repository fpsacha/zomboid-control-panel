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

// Single combined hash over an entire directory tree, used to verify the
// staged client bundle the same way sha256File() verifies the staged binary.
// Files are visited in ORDINAL order (plain string comparison, not
// localeCompare) specifically because this value is written once here (in
// Node) and re-verified independently in two other places -- applyUpdateBundle()
// below (Node, Linux) and the PowerShell embedded in build.js's generated
// Start.bat (Windows, no Node available at apply time). Ordinal is the one
// ordering both runtimes can reproduce byte-for-byte without agreeing on a
// locale.
// main-is-red, 2026-09-05: returns { hash, pairs } instead of just the
// combined hash. `pairs` (one "relativePath:fileHash" string per file,
// same ordinal order and format the PowerShell mirror in build.js's
// Start.bat now logs on a mismatch) exists purely for side-by-side
// diagnosis -- stageUpdateBundle() below persists it into the journal
// specifically so a real mismatch on Windows can be compared against what
// Node actually hashed, without needing to re-derive it after the fact
// from a staged directory that may no longer exist by the time anyone
// looks.
function sha256Directory(dirPath) {
  const pairs = [];
  const walk = (dir, rel) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        pairs.push(`${relativePath}:${sha256File(absolutePath)}`);
      } else {
        throw updateError(
          "invalid_bundle",
          `Unsupported client bundle entry: ${relativePath}`,
        );
      }
    }
  };
  walk(dirPath, "");
  const parts = pairs.map((pair) => {
    const separatorIndex = pair.indexOf(":");
    const relativePath = pair.slice(0, separatorIndex);
    const fileHash = pair.slice(separatorIndex + 1);
    return `${relativePath}\0${fileHash}\n`;
  });
  const hash = crypto.createHash("sha256").update(parts.join(""), "utf8").digest("hex");
  return { hash, pairs };
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

// GH#149, 2026-09-08 (god-verified root cause): f69c2f7f added clientSha256
// as a REQUIRED field without bumping schemaVersion, so a journal staged by
// any pre-f69c2f7f binary (v1.2.15 and earlier -- `hashes: { binarySha256 }`
// only, no clientSha256 at all) gets unconditionally rejected as
// invalid_bundle the instant a post-f69c2f7f binary reads it. Since the
// journal is written by the OLD binary and read by the NEW one on every
// single update attempt, this was a 100%-deterministic, permanent brick for
// that entire version cohort -- re-downloading could never help, because
// the OLD binary writes the identical legacy-shaped journal every time.
//
// Fix: schemaVersion now has two accepted values. 1 (legacy) means "staged
// by a binary that never verified the client bundle's integrity" -- exactly
// what every pre-f69c2f7f release actually did, so accepting it here is not
// a weakening, just declining to invent a check the staging binary itself
// never performed. 2 (current) means clientSha256 is REQUIRED, because the
// binary that staged it computed and wrote one. New journals are always
// written as schema 2 (see stageUpdateBundle() below) -- this branch exists
// to keep READING old ones from bricking an install, not to keep writing
// them.
const LEGACY_SCHEMA_VERSION = 1;
const CURRENT_SCHEMA_VERSION = 2;

function validateJournal(journal, journalPath) {
  if (
    !journal ||
    (journal.schemaVersion !== LEGACY_SCHEMA_VERSION &&
      journal.schemaVersion !== CURRENT_SCHEMA_VERSION) ||
    typeof journal.transactionId !== "string" ||
    journal.transactionId === "" ||
    typeof journal.version !== "string" ||
    !JOURNAL_PHASES.has(journal.phase) ||
    typeof journal.installDir !== "string" ||
    !hasValidMetadata(journal.metadata) ||
    typeof journal.hashes?.binarySha256 !== "string" ||
    journal.hashes.binarySha256 === "" ||
    (journal.schemaVersion === CURRENT_SCHEMA_VERSION &&
      (typeof journal.hashes?.clientSha256 !== "string" ||
        journal.hashes.clientSha256 === "")) ||
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

// GH#149: traced, not assumed -- both `previous` and `current` are always
// two reads of the SAME journalPath within one acknowledgeUpdateBundle()
// call (see its two readUpdateBundleJournalIfPresent() calls below), so a
// legacy schema-1 journal produces `clientSha256: undefined` on BOTH reads
// consistently (`undefined === undefined` is true) -- this direct equality
// does not need a schema-aware branch to stay correct for legacy journals.
function sameAcknowledgementState(previous, current) {
  return (
    previous.transactionId === current.transactionId &&
    previous.phase === current.phase &&
    previous.hashes.binarySha256 === current.hashes.binarySha256 &&
    previous.hashes.clientSha256 === current.hashes.clientSha256 &&
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
  const { hash: clientSha256, pairs: clientFiles } = sha256Directory(stagedClientPath);

  const journal = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    transactionId: crypto.randomUUID(),
    version: String(version),
    phase: "staged",
    stagedAt: new Date().toISOString(),
    installDir: resolvedInstallDir,
    metadata: expectedMetadata,
    // clientFiles is diagnostic only (main-is-red, 2026-09-05) -- never
    // read back for verification, only for comparing against the
    // PowerShell mirror's own pairs list when clientSha256 disagrees on
    // Windows despite both sides computing the identical algorithm.
    hashes: { binarySha256, clientSha256, clientFiles },
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

// Shared by rollback() (journal-driven, below) and recoverFromUnreadableJournal()
// (journal-LESS, near the bottom of this file -- the journal itself is the
// thing that's broken there, so it has no journal.paths to read backup
// locations from; its caller derives live/backup paths independently and
// calls this directly). Restoring via a captured-rename intermediate step
// means a failure partway through never leaves `backup` deleted with `live`
// not yet in place -- either both ends land correctly or the backup is
// restored to where it started.
function restoreFromBackupIfPresent(live, backup, isDirectory) {
  const capturedBackup = `${backup}.restoring-${process.pid}`;
  try {
    fs.rmSync(capturedBackup, { recursive: isDirectory, force: true });
    if (!renameIfPresent(backup, capturedBackup)) {
      return { present: false, restored: false };
    }
    try {
      fs.rmSync(live, { recursive: isDirectory, force: true });
      fs.renameSync(capturedBackup, live);
      return { present: true, restored: true };
    } catch (error) {
      renameIfPresent(capturedBackup, backup);
      return { present: true, restored: false, error };
    }
  } catch (error) {
    return { present: true, restored: false, error };
  }
}

function rollback(journalPath, journal, reason) {
  const { paths } = journal;
  const rollbackErrors = [];
  const restore = (live, backup, isDirectory) => {
    const result = restoreFromBackupIfPresent(live, backup, isDirectory);
    if (result.present && !result.restored) {
      rollbackErrors.push(result.error.message);
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
  // main-is-red, 2026-09-05: mirrors the same fix just shipped on the
  // Windows side (build.js) -- "I could not even hash this" (ENOENT, or
  // any other read failure: permission denied, a mid-read I/O error) and
  // "I hashed it and it differs" were both stamped av_quarantine here,
  // exactly the conflation an operator whose AV holds the staged file for
  // a moment, or whose install hit a transient permission issue, would hit
  // and have it misreported as corruption instead of environment. Distinct
  // hash_unverifiable code for the former, with the real underlying error
  // preserved as .cause; av_quarantine now means only a genuine, computed
  // mismatch. Both still fail closed -- distinguishing the label does not
  // make either check lenient.
  let stagedBinaryHash;
  try {
    stagedBinaryHash = sha256File(paths.stagedBinary);
  } catch (error) {
    throw updateError("hash_unverifiable", "Could not verify staged update binary", error);
  }
  if (stagedBinaryHash !== journal.hashes.binarySha256) {
    throw updateError("av_quarantine", "Staged update binary hash changed");
  }
  // GH#149, corrected 2026-09-08 (god's own regression on the first pass):
  // gated on the hash actually BEING PRESENT, not on schemaVersion. f69c2f7f
  // added clientSha256 without bumping schemaVersion, so schema 1 covers two
  // real shapes on disk: v1.2.15-and-earlier (no clientSha256 at all -- see
  // validateJournal()'s own comment above) AND v1.2.16-v1.2.20 (schema
  // STILL 1, but a real, valid clientSha256 -- confirmed via `git show
  // v1.2.16:...`/`v1.2.20:...`, not assumed). Gating on schemaVersion
  // === CURRENT_SCHEMA_VERSION (2) would have silently disabled this
  // integrity check for that entire v1.2.16-v1.2.20 cohort -- the majority
  // of real installs, not the v1.2.15 minority this fix exists for. That
  // would trade a rare permanent brick for a silent, universal loss of the
  // exact check f69c2f7f was written to add.
  //
  // The "a future journal could lose this field" worry that originally
  // justified schema-keying is already closed by question 1 (is the field
  // REQUIRED), which validateJournal() answers correctly: at schema 2 the
  // field is required, so a schema-2 journal missing it throws
  // invalid_bundle there and never reaches this function at all.
  // Presence-keying here is safe precisely because validation already
  // version-keys -- these are two different questions (is it required vs.
  // should we verify it) and only the first one is about schemaVersion.
  //
  // Decided, not incidental: a schema-1 journal with a MALFORMED
  // clientSha256 (present but empty, or not a string) is treated the same
  // as absent -- skipped, not compared. Schema 1 never guaranteed this
  // field's validity in the first place (only schema 2's validateJournal()
  // check does that), so a malformed value here is exactly as untrusted as
  // a missing one; there is nothing more honest to do with it than skip,
  // same as the legacy no-hash case.
  const stagedClientHashToCompare =
    typeof journal.hashes?.clientSha256 === "string" &&
    journal.hashes.clientSha256 !== ""
      ? journal.hashes.clientSha256
      : null;
  if (stagedClientHashToCompare) {
    let stagedClientHash;
    try {
      ({ hash: stagedClientHash } = sha256Directory(paths.stagedClient));
    } catch (error) {
      throw updateError("hash_unverifiable", "Could not verify staged client bundle", error);
    }
    if (stagedClientHash !== stagedClientHashToCompare) {
      throw updateError("av_quarantine", "Staged client bundle hash changed");
    }
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

// Hotfix, 2026-09-07 (god's dispatch, "hotfix-invalid-bundle" -- a real
// v1.2.16 user was permanently stuck at exit code 76 on `invalid_bundle`):
// recoverInterruptedUpdateBundle() above needs a JOURNAL to know what to
// roll back to -- its first line re-reads the very same journalPath that
// just failed. That is fine for version_mismatch (the journal parsed and
// validated fine; only the build METADATA it describes was wrong) but
// cannot work when the journal itself is what's unreadable: unparseable
// JSON, a structurally-invalid journal, an installDir that no longer
// matches where this journalPath actually lives (e.g. the install folder
// was moved/reinstalled/restored-from-backup with a stale journal still
// inside it), or an I/O error inspecting it. Calling
// recoverInterruptedUpdateBundle() in that state just re-throws the exact
// same invalid_bundle it was meant to recover from.
//
// This is the fallback for exactly that case. It cannot ask the journal
// what to restore, so it does not try to -- stageUpdateBundle() always
// writes its previous-binary/previous-client backups at FIXED locations
// derived only from the live binary/client paths (`<binary>.bundle-previous`,
// `dist.previous` next to the live client dir), independent of anything the
// journal itself contains. Best-effort restore from those fixed locations,
// then move the unreadable journal ASIDE (renamed, not deleted -- keeps the
// evidence for whoever investigates why it went bad) so it can never again
// be the reason startup refuses forever. The now-meaningless
// `.update-applying` marker (nothing left to reference it once its journal
// is gone) is removed outright rather than renamed -- it carries no
// diagnostic content of its own, just presence/absence.
//
// The principle this exists to satisfy: a file the panel wrote, that the
// panel cannot read, must not be the panel's permanent death sentence.
// Refusing to start THIS attempt is a reasonable response to a corrupt
// update; refusing to start every subsequent attempt, forever, with no way
// back, is not.
export function recoverFromUnreadableJournal({
  journalPath,
  binaryPath,
  liveClientPath,
}) {
  const backupBinaryPath = `${binaryPath}.bundle-previous`;
  const backupClientPath = path.join(path.dirname(liveClientPath), "dist.previous");

  const binaryResult = restoreFromBackupIfPresent(binaryPath, backupBinaryPath, false);
  if (binaryResult.present && !binaryResult.restored) {
    throw updateError(
      "rollback_failed",
      `Could not restore the previous panel binary from ${backupBinaryPath}: ${binaryResult.error.message}`,
      binaryResult.error,
    );
  }

  const clientResult = restoreFromBackupIfPresent(liveClientPath, backupClientPath, true);
  if (clientResult.present && !clientResult.restored) {
    throw updateError(
      "rollback_failed",
      `Could not restore the previous panel frontend from ${backupClientPath}: ${clientResult.error.message}`,
      clientResult.error,
    );
  }

  const quarantinedJournalPath = `${journalPath}.corrupt-${Date.now()}`;
  let quarantined = false;
  try {
    quarantined = renameIfPresent(journalPath, quarantinedJournalPath);
  } catch {
    // Best-effort: even if the journal itself can't be moved aside (e.g. a
    // read-only mount), we still report what WAS restored below, and the
    // caller's own actionable log names journalPath directly as the manual
    // fallback -- an operator who has to delete it by hand still has an
    // exact path, not a guess.
  }

  const applyingMarkerPath = path.join(path.dirname(journalPath), ".update-applying");
  try {
    fs.rmSync(applyingMarkerPath, { force: true });
  } catch {
    // Best-effort, same reasoning as above -- not fatal to the recovery.
  }

  return {
    restoredBinary: binaryResult.restored,
    restoredClient: clientResult.restored,
    quarantinedJournalPath: quarantined ? quarantinedJournalPath : null,
  };
}
