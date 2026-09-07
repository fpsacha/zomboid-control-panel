import fs from "fs";
import { getActiveServer } from "../database/init.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ConfigMutationGuard");

// Mirrors database/init.js's normalizeServerMemory() path resolution
// (installPath/zomboidDataPath, falling back to PZ_SERVER_PATH/
// PZ_SAVE_PATH) so this guard's own "is the configured path reachable
// right now" check agrees with what normalization would compute from the
// same server record. Deliberately duplicated rather than imported:
// normalizeServerMemory's unit of work is a fully-shaped server object,
// not this boolean pair, and threading a new export through a function
// nine other files already call is a bigger change than this guard needs.
// If that resolution logic changes, check here too.
function resolveLocalPathReachability(server) {
  const installPath = server?.installPath || process.env.PZ_SERVER_PATH || "";
  const zomboidDataPath = server?.zomboidDataPath || process.env.PZ_SAVE_PATH || null;
  const pathsConfigured = Boolean(installPath || zomboidDataPath);
  const pathsExistLocally =
    Boolean(installPath && fs.existsSync(installPath)) ||
    Boolean(zomboidDataPath && fs.existsSync(zomboidDataPath));
  return { pathsConfigured, pathsExistLocally };
}

// Refuses a request outright while the server is running. As of 2026-08-23
// this is used for WHOLESALE FILE OVERWRITES only (restoring a backup,
// applying a template) — see serverFiles.js's isLocalConfigOverwrite() and
// the comment above LOCAL_CONFIG_MUTATIONS for why those stay blocked while
// ordinary edits to the same files do not.
export async function requireStoppedForLocalConfigMutation(req, res, next) {
  try {
    const activeServer = await getActiveServer();

    // activeServer.isRemote is COMPUTED, not stored -- normalizeServerMemory
    // infers it fresh from whether the configured path currently resolves on
    // this filesystem, specifically so a stale stored flag self-heals (see
    // 2a6c9b4's own commit message). That self-healing is right for most of
    // isRemote's other 17 consumers, which mostly choose a local-vs-SFTP
    // code path and fail loud if wrong. It is the wrong signal to trust HERE
    // specifically: a transiently-unreachable LOCAL path (a disconnected
    // network mount, a slow-mounting drive, an antivirus lock -- this app's
    // own docs support network-attached install paths, so this is a real
    // configuration, not a contrived one) reads as "remote" and would skip
    // the stopped-check entirely, letting a wholesale local config overwrite
    // proceed against a server that may still be running -- exactly what
    // this guard exists to prevent. backup.js's POST /restore/:name reads
    // the identical activeServer.isRemote signal and REFUSES in that
    // ambiguous case (BACKUP_RESTORE_REMOTE_NOT_AVAILABLE) rather than
    // proceeding -- the safe direction to be wrong in, since a false refusal
    // costs a confusing error and a false proceed costs an unrecoverable
    // overwrite. This guard adopts the same posture: a path that is
    // CONFIGURED but does not resolve right now means "can't verify",
    // not "remote". Only the no-path-configured case (a server genuinely
    // never given a local path -- pure SFTP management, isRemote required
    // true and installPath never asked for at creation, see servers.js POST
    // /) still means remote. Found via a real intermittent test failure
    // (2026-08-26) that reproduced this exact shape by accident -- see
    // upnpEditAppliesLive.test.js's afterEach fix for how.
    const { pathsConfigured, pathsExistLocally } = resolveLocalPathReachability(activeServer);
    if (pathsConfigured && !pathsExistLocally) {
      return res.status(503).json({
        code: "SERVER_STATE_UNKNOWN",
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
      });
    }
    if (activeServer?.isRemote) return next();

    const serverManager = req.app?.get?.("serverManager");
    // getServerProcessDetails(), not checkServerRunning() -- the latter
    // discards the scan's own scanFailed flag and returns a plain boolean,
    // so a scan that completed but couldn't determine the server's state
    // (timeout, PowerShell/exec error) came back indistinguishable from
    // "confirmed stopped" and let this wholesale overwrite proceed, exactly
    // the case this guard exists to refuse. Same fail-open class already
    // fixed at /wipe, backup restore, and chunks.js's delete-chunks/
    // delete-region.
    if (typeof serverManager?.getServerProcessDetails !== "function") {
      return res.status(503).json({
        code: "SERVER_STATE_UNKNOWN",
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
      });
    }

    // split-derivation sweep, 2026-09-07 (same class as /wipe's pre-fix
    // bug, 5c2e73e9): getServerProcessDetails() internally calls the
    // GUARDED loadConfig(), a no-op once serverManager has loaded any
    // server's config -- so without an explicit reloadConfig() here, this
    // check can silently examine a DIFFERENT, stale server than the
    // `activeServer` this function just read fresh above. Force a real
    // reload and fail closed (matching this function's own posture
    // everywhere else) if it can't be trusted, rather than letting a
    // wholesale overwrite proceed against the wrong server's process state.
    try {
      await serverManager.reloadConfig();
    } catch (error) {
      return res.status(503).json({
        code: "SERVER_STATE_UNKNOWN",
        error: `Can't verify whether the server is actually stopped — reloading its configuration failed (${error.message}). Check the panel's log for the error.`,
      });
    }

    const processDetails = await serverManager.getServerProcessDetails();
    if (processDetails.scanFailed) {
      return res.status(503).json({
        code: "SERVER_STATE_UNKNOWN",
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
      });
    }

    if (processDetails.running) {
      return res.status(409).json({
        code: "SERVER_RUNNING",
        error: "Stop the server before editing configuration.",
      });
    }

    return next();
  } catch (error) {
    log.warn(
      `Could not verify server state before config mutation: ${error.message}`,
    );
    return res.status(503).json({
      code: "SERVER_STATE_UNKNOWN",
      error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
    });
  }
}

// Allows an ordinary local config edit through regardless of server state —
// the operator ruled 2026-08-23 that these should always be permitted, on
// the understanding that a write while the server is running does not take
// effect in the live game until it restarts (see serverFiles.js's
// LOCAL_CONFIG_MUTATIONS comment for the measurement behind that ruling and
// what it does/doesn't cover). This function's only job is to tell each
// route handler, via req.configEditRestartWarning, whether it should say so
// in its response — it never blocks.
//
// "Cannot verify" is treated the same as "running", not as "stopped": the
// 1.2.0 release fixed exactly this class of bug elsewhere in the panel (a
// server-state check that silently meant "assume stopped" when it couldn't
// tell), and defaulting to warn is the harmless direction to be wrong in —
// an unnecessary warning costs a reader a sentence; a missing one costs them
// a config change they believe took effect and didn't.
export async function warnRunningForLocalConfigEdit(req, res, next) {
  try {
    const activeServer = await getActiveServer();

    // Same ambiguity as this file's sibling guard above, and the same fix:
    // a path that is CONFIGURED but does not resolve right now (a
    // disconnected network mount, a slow-mounting drive, an antivirus lock)
    // must not be trusted as "remote" just because isRemote self-healed to
    // true. Unlike the sibling, this function never blocks -- "can't
    // verify" here means "warn", per this function's own documented policy
    // above, not "refuse".
    const { pathsConfigured, pathsExistLocally } = resolveLocalPathReachability(activeServer);
    if (pathsConfigured && !pathsExistLocally) {
      req.configEditRestartWarning = true;
      return next();
    }
    if (activeServer?.isRemote) return next();

    const serverManager = req.app?.get?.("serverManager");
    // getServerProcessDetails(), not checkServerRunning() -- same reason as
    // this file's sibling guard above. checkServerRunning() discards the
    // scan's own scanFailed flag and collapses a failed scan straight to
    // `running: false`, so `running !== false` below was false on a scan
    // failure and NO warning was shown -- the exact opposite of this
    // function's own documented policy ("cannot verify is treated the same
    // as running... defaulting to warn is the harmless direction"). Found
    // in the 2026-08-26 bug hunt: two functions in this one file, one
    // hardened to getServerProcessDetails() and one never migrated.
    if (typeof serverManager?.getServerProcessDetails !== "function") {
      req.configEditRestartWarning = true;
      return next();
    }

    // split-derivation sweep, 2026-09-07: same reload-before-trust fix as
    // this file's sibling guard above, adapted to this function's own
    // never-block policy -- a reload failure here means "can't verify",
    // which per this function's documented policy is treated as "warn",
    // not refused.
    try {
      await serverManager.reloadConfig();
    } catch {
      req.configEditRestartWarning = true;
      return next();
    }

    const processDetails = await serverManager
      .getServerProcessDetails()
      .catch(() => ({ running: true, scanFailed: true }));
    req.configEditRestartWarning =
      processDetails.scanFailed || processDetails.running !== false;
    return next();
  } catch (error) {
    log.warn(
      `Could not verify server state before config edit: ${error.message}`,
    );
    req.configEditRestartWarning = true;
    return next();
  }
}
