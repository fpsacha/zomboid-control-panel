import express from "express";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import https from "https";
import path from "path";
import fs from "fs";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import os from "os";
import crypto from "crypto";
import { createLogger } from "../utils/logger.js";
import { resolveEnvRconHost } from "../services/rcon.js";
const log = createLogger("API:Server");
import {
  logServerEvent,
  setSetting,
  getSetting,
  getActiveServer,
  getServer,
  getServers,
} from "../database/init.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import {
  rconPasswordCannotBeStoredInIni,
  rconPasswordUnsupportedCharsBody,
} from "../utils/rconPassword.js";
import {
  hasIniKeyValue,
  setIniKeyLine,
  withOriginalLineEnding,
  restoreLineEnding,
} from "../utils/iniKeyWrite.js";
import {
  launchesPanelStartScript,
  managedStartupScriptName,
  resolveLaunchMode,
  ServerManager,
  scanLeavesServerUnknown,
  scoreServerProcessOwnership,
} from "../services/serverManager.js";
import {
  isSteamOperationIdle,
  getActiveSteamOperations,
  clearActiveSteamOperation,
  hasActiveSteamOperation,
  recordActiveSteamOperationPid,
  STEAM_OPERATION_IDLE_TIMEOUT_MS,
} from "../services/activeSteamOperations.js";
import { normalizeMemoryGb, normalizeMinMemoryGb } from "../utils/memory.js";
import { withFileLock, writeFileAtomic } from "../utils/fileWriteQueue.js";
import { requirePermission } from "../services/permissions.js";
import { canSeeHostPaths, hideHostPaths } from "../utils/hostPathView.js";
import { canSeeRconTarget, withoutRconConfigTarget } from "../utils/rconTargetView.js";
import { runManagedLifecycle } from "../services/managedContainer.js";
import {
  acquireLifecycleLock,
  getLifecycleLockHolder,
  holdServerUntilRcon,
  supersedeLifecycleLock,
  lifecycleInProgressResponse,
  isLifecycleLockedForServer,
} from "../services/lifecycleCoordinator.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { ProgressCode } from "../utils/progressCodes.js";
import { invalidateMapFolderScan } from "./chunks.js";
import { codedActionResultFields, emitActionResult } from "./scheduler.js";
import panelBridge from "../services/panelBridge.js";
import { resolveObservedServerRunning } from "../utils/serverStatus.js";
import { candidateIniPaths } from "../utils/zomboidPaths.js";
import { serverHasWorldFolder } from "../utils/savesFolder.js";
import { adminPasswordStartScriptRefusal } from "../services/startScriptValues.js";
import {
  quoteForBatch,
  quoteForShell,
  textForScriptComment,
} from "../utils/startScriptQuoting.js";
import { untrustedFolderReason } from "../utils/untrustedFolder.js";
import {
  checkZomboidDataPath,
  describeRefusal,
  gameLogFolderOf,
  logRefusalOnce,
  zomboidDataFolderHolds,
  zomboidDataFolderRefusal,
} from "../services/zomboidDataPath.js";
import {
  activeServerConfigDir,
  serverConfigDirOf,
  serverConfigDirRefusal,
  serverFolderProblem,
} from "../utils/serverConfigPath.js";
import {
  describeLeftoverNativeLibraries,
  detectLeftoverNativeLibraries,
  formatJavaLibraryPath,
  formatShellLibraryDirs,
  resolveGameDirForNativeCheck,
  resolveNativeLibraryDirs,
} from "../utils/nativeLibraryPaths.js";
import {
  newProfileConflictsWithWorkshop,
  noSteamWorkshopConflictResponse,
  reconcileBridge,
} from "../services/bridgeDelivery.js";
import { parseBoundedInteger } from "../utils/queryNumbers.js";
import { confineToRoots } from "../utils/browseRoots.js";
import { isContainerized } from "../utils/dockerDetect.js";
import {
  createLinuxServiceLifecycle,
  isManagedLifecycleProvider,
} from "../services/linuxServiceLifecycle.js";
import {
  inspectSelfContainerMounts,
  isOnContainerRootLayer,
  translateHostPath,
} from "../utils/containerMountInfo.js";
import {
  collectUsedPorts,
  getAllInOneLayout,
  getEnvironmentDataPath,
  suggestFreePorts,
  suggestHostServersRoot,
} from "../services/serverPortPlan.js";
import { installDirKey } from "../services/bridgeDisk.js";
import { resolveInstallDir } from "../services/panelBridgeInstaller.js";
import { isUnmanagedRemoteServer } from "../utils/serverStatusModel.js";
import { redactGameLogSecrets } from "../utils/gameLogSecrets.js";

const router = express.Router();

const isWindows = process.platform === "win32";
const execAsync = promisify(exec);

export async function logServerEventBestEffort(...args) {
  try {
    await logServerEvent(...args);
  } catch (error) {
    log.warn(`Could not record server event: ${error.message}`);
  }
}

// Files that only exist in a real PZ server install -- used both to guard
// against deleting the wrong folder (DELETE /delete-files) and, since
// 2026-08-26, to confirm SteamCMD's app_update actually produced a usable
// install rather than just exiting 0 (POST /install). Shared so the two
// checks can't drift apart into two different ideas of "this looks like a
// PZ server."
export const PZ_INSTALL_MARKERS = [
  "ProjectZomboid64.json",
  "ProjectZomboid32.json",
  "StartServer64.bat",
  "StartServer32.bat",
  "start-server.sh",
];

export function hasPzInstallMarker(dirPath) {
  return PZ_INSTALL_MARKERS.some((marker) => fs.existsSync(path.join(dirPath, marker)));
}

// Get the SteamCMD executable name for the current platform
function getSteamCmdExe(steamcmdPath) {
  const primary = path.join(
    steamcmdPath,
    isWindows ? "steamcmd.exe" : "steamcmd.sh",
  );
  if (fs.existsSync(primary)) return primary;
  // Fallback: plain 'steamcmd' binary (package-manager installs on Linux)
  const fallback = path.join(steamcmdPath, "steamcmd");
  if (!isWindows && fs.existsSync(fallback)) return fallback;
  // System-wide fallback (CentOS/Ubuntu package manager installs)
  if (!isWindows) {
    for (const sysPath of [
      "/usr/games/steamcmd",
      "/usr/bin/steamcmd",
      "/usr/local/bin/steamcmd",
    ]) {
      if (fs.existsSync(sysPath)) return sysPath;
    }
  }
  return primary; // Return primary path even if not found — let caller handle the error
}

// CodeQL js/command-line-injection #10,11,12,13,297 (2026-08-27 triage,
// operator-ruled fix): every call site used to resolve steamcmdExe from a
// per-request steamcmdPath/installPath value, checked only for absoluteness
// and no traversal (isValidPath) -- the DIRECTORY a binary got spawned from
// was fully caller-chosen within one request, with no persistent record of
// intent. Operator's own reasoning for choosing this over a stronger
// capability gate: "a gate on top of a per-request executable path still
// leaves a per-request executable path -- it relies on that gate being
// right forever."
//
// THE RULE, not a count of call sites: no spawn() of a SteamCMD-family
// executable may ever resolve steamcmdExe from a path that wasn't
// persisted as the saved steamcmdPath setting first. Calling this function
// is how an async call site does that. A context that doesn't want to
// re-await it (see POST /steamcmd/download's own fire-and-forget call into
// runSteamCmdFirstTimeSetup() below) may resolve via the lower-level
// getSteamCmdExe() directly instead, but ONLY when reusing a path this
// function already persisted earlier in the SAME request -- that call site
// documents exactly that at its own call. "The single point every spawn()
// goes through" was asserted here once (bughunt-2026-08-31-b,
// completeness-claims audit) and was already false the day it was written;
// check a given spawn() against the rule above, not against this comment's
// name for itself, since a future exception won't update this count either.
//
// candidatePath, when the caller has one (the operator typed/browsed to it
// in THIS request, already passed through isValidPath by the caller), gets
// PERSISTED before this function ever reads the setting back -- so "saved"
// and "used" can never observably diverge, even within the same request
// that just picked the path. Browsing to preview a not-yet-installed path
// still works exactly as before; the difference is that path is now saved
// as a side effect of being previewed/used, not read back from the request
// object a second time for the actual spawn. Omitting candidatePath is the
// steady-state case: resolve whatever is already saved.
// SECURITY (2026-10-28): SteamCMD is a program the panel runs, so it is never
// run from a Steam Workshop download folder or a Windows network share,
// whose files anyone can supply (utils/untrustedFolder.js): server.install
// could otherwise point it at a downloaded Workshop item. Refused where a
// request names the folder, and again in saveAndResolveSteamCmdExe(), so a
// folder saved before this check doesn't run either.
export function steamCmdFolderRefusal(dir) {
  if (!untrustedFolderReason(dir)) return null;
  return {
    error:
      "SteamCMD can't be used from this folder: it is inside a Steam Workshop download folder or on a network share, whose files anyone could supply. Choose the folder SteamCMD is installed in on this computer.",
    code: ErrorCode.STEAMCMD_FOLDER_REFUSED,
  };
}

function throwIfSteamCmdFolderRefused(dir) {
  const refusal = steamCmdFolderRefusal(dir);
  if (refusal) throw Object.assign(new Error(refusal.error), { code: refusal.code });
}

async function saveAndResolveSteamCmdExe(candidatePath) {
  if (candidatePath) {
    throwIfSteamCmdFolderRefused(candidatePath);
    const current = await getSetting("steamcmdPath");
    if (current !== candidatePath) {
      await setSetting("steamcmdPath", candidatePath);
    }
    // Resolve from candidatePath directly rather than reading the setting
    // back a second time: setSetting() has already been awaited to
    // completion above, so "saved" and "used" can't diverge within this
    // request regardless of it. Re-reading would only add a redundant round
    // trip with no extra safety -- it can't protect against a genuinely
    // concurrent writer from a DIFFERENT request either.
    return getSteamCmdExe(candidatePath);
  }
  const configuredPath = await getSetting("steamcmdPath");
  throwIfSteamCmdFolderRefused(configuredPath);
  return configuredPath ? getSteamCmdExe(configuredPath) : null;
}

// Emits one line of SteamCMD's OWN stdout/stderr, forwarded verbatim, with
// no `progressCode` field and no way to attach one. This is the ONLY
// function in this file allowed to emit install:log, steam:log or
// steamcmd:log for a raw passthrough line -- every other emit of those
// three events is an authored line and must carry a progressCode instead.
// That split used to be enforced only by which event name a call site
// picked, and it was violated exactly once (the 32-bit-library warning
// below, our own text going out through steamcmd:log) before anyone was
// even trying to maintain the rule -- see ProgressCode's file header. Going
// through this helper (or not) is what makes "raw" and "authored" mutually
// exclusive now, not a comment.
function emitRawSteamCmdLine(io, event, type, text, extra) {
  io?.to("install").emit(event, { type, text, ...(extra || {}) });
}

// GH #147: a real user's SteamCMD install kept failing with "Missing file
// permissions" (exit 8), then "Missing configuration" once he widened the
// GAME install directory's own permissions — a permission change that MOVES
// the error rather than fixing it means the first failure was real and the
// thing widened wasn't what SteamCMD was actually complaining about. His own
// log named it directly: `Redirecting stderr to
// '/home/pzuser/Steam/logs/stderr.txt'` -- SteamCMD resolves its OWN client
// state (login cache, depot/workshop staging, logs) from $HOME, entirely
// separate from wherever `+force_install_dir` points the actual game files.
// The panel's bundled systemd unit (zomboid-panel.service) sandboxes the
// service with `ProtectHome=read-only`, which makes every write under
// $HOME fail at the mount-namespace level regardless of the target's own
// filesystem permissions -- chown/chmod on the install path can't touch it,
// because the real blocker is a completely different path the install guide
// never mentions (it only documents the `ReadWritePaths` trap for the GAME
// install dir itself, not for SteamCMD's own home-relative state).
// Redirecting HOME to a folder inside SteamCMD's own directory sidesteps
// the sandboxed /home entirely -- that directory is already required to be
// writable (SteamCMD downloads and updates itself there), so this needs no
// unit-file edit from the user and no relaxing of ProtectHome.
export function buildLinuxSteamCmdEnv(steamcmdBinDir) {
  const steamHome = path.join(steamcmdBinDir, ".steamhome");
  try {
    fs.mkdirSync(steamHome, { recursive: true });
  } catch (err) {
    log.debug(
      `Could not create SteamCMD HOME override at ${steamHome}: ${err.message}`,
    );
  }
  const ldPaths = [
    path.join(steamcmdBinDir, "linux32"),
    path.join(steamcmdBinDir, "linux64"),
    steamcmdBinDir,
    process.env.LD_LIBRARY_PATH || "",
  ]
    .filter(Boolean)
    .join(":");
  return { ...process.env, LD_LIBRARY_PATH: ldPaths, HOME: steamHome };
}

// Self-heal "SteamCMD not found": downloads, extracts and first-time
// initializes SteamCMD into `installPath` on Linux, mirroring the same
// steps as POST /steamcmd/download. Called from /install and /update when
// the configured steamcmdPath is empty — e.g. a fresh volume, or a
// previous install attempt that never finished (permission error, network
// blip, container restarted mid-download, etc.) instead of hard-failing
// with a 400 and making the user manually re-run the setup wizard.
// Windows is intentionally out of scope here (existing callers already
// keep their own hard-fail for isWindows before calling this).
async function ensureSteamCmdLinux(installPath, io) {
  // Persist installPath as the configured steamcmdPath before resolving
  // anything from it -- see saveAndResolveSteamCmdExe's header comment.
  // Both real callers (POST /install, POST /steam-update) already validate
  // installPath with isValidPath() before reaching here.
  const steamcmdExe = await saveAndResolveSteamCmdExe(installPath);
  if (steamcmdExe && fs.existsSync(steamcmdExe)) return steamcmdExe;

  const emit = (event, payload) => {
    try {
      io?.to("install").emit(event, payload);
    } catch {
      /* best effort */
    }
  };

  log.warn(
    `SteamCMD not found at ${steamcmdExe}; auto-downloading to ${installPath}...`,
  );
  emit("steamcmd:status", {
    status: "downloading",
    message: "SteamCMD missing — downloading it now...",
    progressCode: ProgressCode.STEAMCMD_LINUX_AUTO_DOWNLOAD_START,
  });

  if (!fs.existsSync(installPath)) {
    fs.mkdirSync(installPath, { recursive: true });
  }

  const tarUrl =
    "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz";
  const tarPath = path.join(installPath, "steamcmd_linux.tar.gz");
  const safeTarPath = tarPath.replace(/'/g, "'\\''");
  const safeTarUrl = tarUrl.replace(/'/g, "'\\''");
  const safeInstallPath = installPath.replace(/'/g, "'\\''");

  try {
    await execAsync(`curl -sSL -o '${safeTarPath}' '${safeTarUrl}'`, {
      timeout: 120000,
    });
  } catch (curlErr) {
    log.warn(`curl download failed (${curlErr.message}), trying wget...`);
    await execAsync(`wget -q -O '${safeTarPath}' '${safeTarUrl}'`, {
      timeout: 120000,
    });
  }

  emit("steamcmd:status", {
    status: "extracting",
    message: "Extracting SteamCMD...",
    progressCode: ProgressCode.STEAMCMD_EXTRACTING,
  });
  await execAsync(`tar -xzf '${safeTarPath}' -C '${safeInstallPath}'`, {
    timeout: 30000,
  });
  try {
    fs.unlinkSync(tarPath);
  } catch {
    /* ignore */
  }
  try {
    fs.chmodSync(path.join(installPath, "steamcmd.sh"), 0o755);
  } catch {
    /* ignore */
  }
  try {
    fs.chmodSync(path.join(installPath, "steamcmd"), 0o755);
  } catch {
    /* ignore */
  }

  // windows-steamcmd-selfheal, 2026-09-10: the first-run step used to be
  // inlined here as its own Promise -- now shared with ensureSteamCmdWindows
  // and both branches of the manual POST /steamcmd/download route via
  // runSteamCmdFirstTimeSetup() below, so a future change to the
  // success/failure contract (what counts as "done", what gets emitted)
  // can't drift between four independently-maintained copies of the same
  // spawn(...+quit) logic.
  return runSteamCmdFirstTimeSetup(steamcmdExe, installPath, io);
}

// Shared "first launch" step for a freshly-provisioned SteamCMD binary on
// EITHER platform: a non-interactive `+quit` run (SteamCMD downloads its own
// client update and writes its local cache on first launch, no stdin
// prompt -- proven safe already, this is exactly what real users already
// trigger via the manual download button below on both platforms). Exit
// code 7 is SteamCMD's own "no command given" code, expected here since
// +quit is the only argument -- both 0 and 7 mean the binary launched and
// initialized correctly, matching every pre-existing caller's own check.
//
// windows-steamcmd-selfheal, 2026-09-10 (god-directed unification): before
// this, TWO independent first-run implementations existed -- this one
// (inlined in ensureSteamCmdLinux, awaitable, re-verified fs.existsSync
// after close) and POST /steamcmd/download's own runFirstTimeSetup()
// (shared only between that route's own Linux/Windows branches,
// fire-and-forget, no existence re-check). Unified into the one function
// below, used by all four call sites now, so the success/failure contract
// can't drift between them the way ensureSteamCmdLinux and Kevin's download
// guard already had (see ensureSteamCmdInstalled's own comment). The one
// observable behavior change from unifying: the manual route's path now
// also re-verifies fs.existsSync(steamcmdExe) after a 0/7 close before
// declaring success -- purely additive, cannot fail on a real successful
// run, only catches the same "exited clean but the binary still isn't
// there" edge case ensureSteamCmdLinux already guarded against.
export const STEAMCMD_FIRST_RUN_TIMEOUT_MS = 120000;

export function runSteamCmdFirstTimeSetup(steamcmdExe, installPath, io) {
  return new Promise((resolve, reject) => {
    const firstRunOpts = { cwd: installPath };
    if (!isWindows) {
      firstRunOpts.env = buildLinuxSteamCmdEnv(installPath);
    }

    io?.to("install").emit("steamcmd:status", {
      status: "initializing",
      message: "Initializing SteamCMD (first run)...",
      progressCode: ProgressCode.STEAMCMD_INITIALIZING,
    });
    log.info("Running SteamCMD first-time setup...");

    const steamcmd = spawn(steamcmdExe, ["+quit"], firstRunOpts);

    steamcmd.stdout.on("data", (data) => {
      emitRawSteamCmdLine(io, "steamcmd:log", "stdout", data.toString());
    });
    steamcmd.stderr.on("data", (data) => {
      emitRawSteamCmdLine(io, "steamcmd:log", "stderr", data.toString());
    });

    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      steamcmd.kill();
      const message = `SteamCMD first-run setup timed out after ${STEAMCMD_FIRST_RUN_TIMEOUT_MS}ms`;
      io?.to("install").emit("steamcmd:status", {
        status: "error",
        message,
        progressCode: ProgressCode.STEAMCMD_SETUP_FAILED,
        params: { reason: message },
      });
      log.error(message);
      reject(new Error(message));
    }, STEAMCMD_FIRST_RUN_TIMEOUT_MS);

    steamcmd.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (code !== 0 && code !== 7) {
        io?.to("install").emit("steamcmd:status", {
          status: "error",
          message: `SteamCMD setup failed with code ${code}`,
          progressCode: ProgressCode.STEAMCMD_SETUP_FAILED,
          params: { code },
        });
        log.error(`SteamCMD first-run failed with code ${code}`);
        reject(new Error(`SteamCMD first-run setup exited with code ${code}`));
        return;
      }
      if (!fs.existsSync(steamcmdExe)) {
        // windows-steamcmd-selfheal, 2026-09-10: this rejection previously
        // emitted nothing (matching ensureSteamCmdLinux's own pre-existing
        // gap, faithfully preserved by this unification) -- now that the
        // MANUAL route also goes through this same function, that silence
        // became a real UX gap there: the operator's last visible status
        // would stay "Initializing SteamCMD (first run)..." forever, no
        // completion, no error toast, for a run that exits claiming success
        // (0 or 7) but somehow still leaves the binary missing. Reuses
        // STEAMCMD_SELF_SETUP_UNEXPECTED_ERROR -- previously a generic
        // caller-side backstop for a failure mode that could never actually
        // reach it (see that route's own historical comment) -- for the one
        // genuinely-unexpected outcome this function can produce.
        const message = `SteamCMD download completed but ${steamcmdExe} still missing`;
        io?.to("install").emit("steamcmd:status", {
          status: "error",
          message: `SteamCMD setup failed unexpectedly: ${message}`,
          progressCode: ProgressCode.STEAMCMD_SELF_SETUP_UNEXPECTED_ERROR,
          params: { reason: message },
        });
        log.error(message);
        reject(new Error(message));
        return;
      }
      io?.to("install").emit("steamcmd:status", {
        status: "complete",
        message: "SteamCMD installed successfully!",
        path: installPath,
        progressCode: ProgressCode.STEAMCMD_INSTALL_COMPLETE,
      });
      log.info(`SteamCMD installed successfully to ${installPath}`);
      resolve(steamcmdExe);
    });

    steamcmd.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      io?.to("install").emit("steamcmd:status", {
        status: "error",
        message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
        progressCode: ProgressCode.STEAMCMD_RUN_FAILED,
        params: { reason: sanitizeError(error.message) },
      });
      log.error(`SteamCMD run error: ${error.message}`);
      reject(error);
    });
  });
}

// Windows counterpart to the Linux manual-download branch inside POST
// /steamcmd/download below -- download the steamcmd.zip and extract it.
// Deliberately does NOT also run first-time-setup (call
// runSteamCmdFirstTimeSetup separately once this resolves) and does NOT
// touch steamcmdDownloadInProgress: this function is pure download+extract
// mechanics, reused by two callers with two different policies around both
// of those. The manual route (below) always reprovisions unconditionally
// when clicked -- a deliberate repair path -- claims the guard itself
// before calling this, and releases it the moment this settles, BEFORE
// starting first-time-setup -- preserving the pre-existing timing (the
// guard protects the shared zip-path write, not the whole provisioning
// process; both platforms' manual branches already released it at this
// same point before this unification). ensureSteamCmdWindows (next) skips
// calling this entirely when steamcmdExe already exists, and ITS caller,
// ensureSteamCmdInstalled, holds the guard through first-run too instead --
// a deliberately simpler, slightly more conservative policy for the
// auto-heal path, documented at ensureSteamCmdInstalled itself. Throws on
// any failure.
//
// windows-steamcmd-selfheal, 2026-09-10: extracted from POST
// /steamcmd/download's own Windows branch, which used to be the only
// Windows download+extract+first-run implementation -- see
// ensureSteamCmdInstalled's own comment for why a second, independent
// implementation for the auto-heal path was rejected in favor of sharing
// this one.
async function provisionSteamCmdWindows(installPath, io) {
  const unzipper = await import("unzipper");
  const steamcmdUrl =
    "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";
  const zipPath = path.join(installPath, "steamcmd.zip");

  log.info(`Downloading SteamCMD to ${installPath}`);

  // https.get's `timeout` option is a SOCKET-IDLE timeout: it only fires if
  // the connection goes quiet, not if the download is simply slow but still
  // receiving bytes -- a different GUARANTEE than curl's {timeout:120000}
  // below (and in ensureSteamCmdLinux), which is a hard wall-clock kill
  // regardless of activity. Reusing the same 120000ms NUMBER here is
  // deliberate (an already-considered value, not invented), but the two are
  // not interchangeable mechanisms -- said explicitly so a future reader
  // doesn't assume "same number" means "same behavior" (god's instruction,
  // 2026-09-10).
  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(zipPath);
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        file.close();
        try {
          fs.unlinkSync(zipPath);
        } catch {
          /* ignore */
        }
        reject(err);
      };

      // The original inline version of this code (pre-unification) never
      // attached its own error listener to the write stream -- only to the
      // https request. A write-side failure (disk full, permission denied,
      // or installPath's directory disappearing mid-write) had no listener
      // at all, which is an unhandled 'error' event on an EventEmitter --
      // an uncaught exception, not a rejected promise this function's own
      // callers could catch. Routes through the same fail() as every other
      // failure here.
      file.on("error", fail);

      const download = (url) => {
        const request = https
          .get(url, { timeout: 120000 }, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
              download(response.headers.location);
              return;
            }
            if (response.statusCode !== 200) {
              fail(new Error(`HTTP ${response.statusCode}`));
              return;
            }
            response.pipe(file);
            file.on("close", () => {
              if (settled) return;
              settled = true;
              resolve();
            });
          })
          .on("error", fail)
          .on("timeout", () => {
            request.destroy();
            fail(new Error("Download timed out after 120000ms"));
          });
      };
      download(steamcmdUrl);
    });
  } catch (downloadError) {
    io?.to("install").emit("steamcmd:status", {
      status: "error",
      message: `Download failed: ${downloadError.message}`,
      progressCode: ProgressCode.STEAMCMD_DOWNLOAD_FAILED,
      params: { reason: downloadError.message },
    });
    log.error(`SteamCMD download failed: ${downloadError.message}`);
    throw downloadError;
  }

  io?.to("install").emit("steamcmd:status", {
    status: "extracting",
    message: "Extracting SteamCMD...",
    progressCode: ProgressCode.STEAMCMD_EXTRACTING,
  });
  log.info("Extracting SteamCMD...");
  try {
    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.default.Extract({ path: installPath }))
      .promise();
  } catch (extractError) {
    io?.to("install").emit("steamcmd:status", {
      status: "error",
      message: `Extraction failed: ${sanitizeError(extractError.message)}`,
      progressCode: ProgressCode.STEAMCMD_EXTRACTION_FAILED,
      params: { reason: sanitizeError(extractError.message) },
    });
    log.error(`SteamCMD extraction failed: ${extractError.message}`);
    throw extractError;
  }
  try {
    fs.unlinkSync(zipPath);
  } catch {
    /* ignore */
  }
}

// Self-heal "SteamCMD not found" for Windows -- SAME awaitable contract as
// ensureSteamCmdLinux above (check-existing, return the existing path
// immediately, else provision and return the newly-installed path, throws
// on failure), built on provisionSteamCmdWindows + runSteamCmdFirstTimeSetup
// so there is exactly one Windows download+extract+first-run implementation
// rather than two independently drifting ones. Called only through
// ensureSteamCmdInstalled below, which owns the steamcmdDownloadInProgress
// claim for this whole call (including first-run) -- this function does not
// touch that guard itself.
async function ensureSteamCmdWindows(installPath, io) {
  const steamcmdExe = await saveAndResolveSteamCmdExe(installPath);
  if (steamcmdExe && fs.existsSync(steamcmdExe)) return steamcmdExe;

  log.warn(
    `SteamCMD not found at ${steamcmdExe}; auto-downloading to ${installPath}...`,
  );
  // STEAMCMD_LINUX_AUTO_DOWNLOAD_START's constant name says LINUX but its
  // text ("SteamCMD missing -- downloading it now...") is already
  // platform-neutral -- deliberately reused here rather than adding a
  // same-text Windows-named twin, which would touch progressCodes.js and
  // all 9 locale files for zero user-visible change (god's call, 2026-09-10).
  io?.to("install").emit("steamcmd:status", {
    status: "downloading",
    message: "SteamCMD missing — downloading it now...",
    progressCode: ProgressCode.STEAMCMD_LINUX_AUTO_DOWNLOAD_START,
  });

  if (!fs.existsSync(installPath)) {
    fs.mkdirSync(installPath, { recursive: true });
  }

  await provisionSteamCmdWindows(installPath, io);
  return runSteamCmdFirstTimeSetup(
    getSteamCmdExe(installPath),
    installPath,
    io,
  );
}

function normalizeSteamBranch(branch) {
  return !branch || branch === "stable" || branch === "public"
    ? "public"
    : branch;
}

function recoverMismatchedSteamBranchManifest(installPath, selectedBranch) {
  const manifestPath = path.join(
    installPath,
    "steamapps",
    "appmanifest_380870.acf",
  );
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = fs.readFileSync(manifestPath, "utf-8");
  const mountedBranch = manifest.match(
    /"MountedConfig"\s*\{[\s\S]*?"BetaKey"\s*"([^"]+)"/,
  )?.[1];
  const targetBranch = normalizeSteamBranch(selectedBranch);
  if (!mountedBranch || mountedBranch === targetBranch) return null;

  const backupPath = `${manifestPath}.bak-${Date.now()}`;
  fs.copyFileSync(manifestPath, backupPath);
  fs.unlinkSync(manifestPath);
  return { mountedBranch, targetBranch, backupPath };
}

// The branch SteamCMD actually mounted after an install or update: the
// appmanifest's MountedConfig BetaKey, "public" without one, null when there
// is no readable manifest. Logged when it isn't the branch that was asked
// for, so "I picked Stable and got 42.19" has a server-side trace.
function warnIfMountedSteamBranchDiffers(installPath, selectedBranch, operation) {
  try {
    const manifest = fs.readFileSync(
      path.join(installPath, "steamapps", "appmanifest_380870.acf"),
      "utf-8",
    );
    const mounted =
      manifest.match(/"MountedConfig"\s*\{[\s\S]*?"BetaKey"\s*"([^"]+)"/)?.[1] || "public";
    const target = normalizeSteamBranch(selectedBranch);
    if (normalizeSteamBranch(mounted) !== target) {
      log.warn(
        `SteamCMD ${operation} finished on the "${mounted}" branch, not "${target}" as requested. Retry the ${operation}; if it persists, delete SteamCMD's appcache folder and steamapps/appmanifest_380870.acf in the server folder first.`,
      );
    }
  } catch {
    // No manifest to compare: nothing to report.
  }
}

export function hasSteamManifestAccessDeniedState(manifest) {
  return /"StateFlags"\s*"6"/.test(manifest);
}

function recoverBlockedSteamManifest(installPath) {
  const manifestPath = path.join(
    installPath,
    "steamapps",
    "appmanifest_380870.acf",
  );
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = fs.readFileSync(manifestPath, "utf-8");
  if (!hasSteamManifestAccessDeniedState(manifest)) return null;

  const backupPath = `${manifestPath}.bak-0x6-${Date.now()}`;
  fs.copyFileSync(manifestPath, backupPath);
  fs.unlinkSync(manifestPath);
  return { backupPath };
}

// Fixed install locations findSteamCmdPath() falls back to after the
// configured setting and STEAMCMD_PATH env var -- the first entry is the
// exact path our own all-in-one image installs SteamCMD to
// (docker/all-in-one/entrypoint.sh), so inside that image detection is
// deterministic, not a guess. Named so POST /install's own missing-field
// error can say where it looked, not just that it failed.
const STEAMCMD_FIXED_CANDIDATE_PATHS = [
  "/home/steam/steamcmd",
  "/home/steam/Steam/steamcmd",
  "/opt/steamcmd",
];

async function findSteamCmdPath() {
  const configuredPath = await getSetting("steamcmdPath");
  const candidates = [
    configuredPath,
    process.env.STEAMCMD_PATH,
    ...STEAMCMD_FIXED_CANDIDATE_PATHS,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(getSteamCmdExe(candidate))) return candidate;
  }

  return null;
}

// activeSteamOperations itself, isSteamOperationIdle, clearActiveSteamOperation
// and hasActiveSteamOperation now live in ../services/activeSteamOperations.js
// (hunt-wave5-2026-08-29) so serverManager.js's startServer() can check the
// same tracked state before spawning the PZ JVM -- see that module's header
// comment for why this couldn't just be a reverse import instead.
const activeSteamOperations = getActiveSteamOperations();

// Guards POST /steamcmd/download (below) AND ensureSteamCmdInstalled (next)
// against overlapping calls both writing the same
// steamcmd.zip/steamcmd_linux.tar.gz -- fire-and-forget sweep, 2026-09-10:
// with no lock, a second request's fs.createWriteStream() truncates the
// first mid-download (and, on error, the first attempt's own
// fire-and-forget cleanup unlink can land on the second attempt's now-live
// file). Module-level like panelUpdateChecker.js's isDownloading -- there is
// exactly one SteamCMD provisioning flow per running panel process, no need
// for activeSteamOperations' per-path keying (that guards the SteamCMD
// *process* once installed, a separate concern from provisioning it).
//
// windows-steamcmd-selfheal, 2026-09-10: originally documented here as
// "shares nothing with those routes' state" -- that was true only because
// ensureSteamCmdLinux() claimed nothing at all, not because the two flows
// were actually independent. They write to the identical file path. See
// ensureSteamCmdInstalled's own comment for the gap that left open and how
// it closes now.
let steamcmdDownloadInProgress = false;

// The ONE place that claims steamcmdDownloadInProgress for the auto-heal
// path (POST /steamcmd/download, below, still claims it independently for
// the manual-button path -- both check/release the SAME module-level flag,
// so a manual download and an auto-heal correctly refuse each other in
// either direction; they just enter through two different call sites by
// design, one operator-initiated with its own pre-checks, one triggered
// implicitly from inside /install and /steam-update).
//
// windows-steamcmd-selfheal, 2026-09-10 (god-directed): before this,
// ensureSteamCmdLinux() claimed nothing here -- a manual download and a
// concurrent /install auto-heal could both write to
// installPath/steamcmd_linux.tar.gz with zero coordination, the exact
// corruption shape the guard above was built to prevent, just never
// extended to this second call path. Building a Windows equivalent without
// closing this would have planted the identical gap on Windows too (racing
// on installPath/steamcmd.zip instead). This function is that close, and
// the single point both ensureSteamCmdLinux and ensureSteamCmdWindows now
// go through -- not two independent claims that can drift again.
async function ensureSteamCmdInstalled(installPath, io) {
  if (steamcmdDownloadInProgress) {
    const err = new Error("A SteamCMD download is already in progress");
    err.code = ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS;
    throw err;
  }
  steamcmdDownloadInProgress = true;
  try {
    return isWindows
      ? await ensureSteamCmdWindows(installPath, io)
      : await ensureSteamCmdLinux(installPath, io);
  } finally {
    steamcmdDownloadInProgress = false;
  }
}

// True only for the exact shape that crashes PZ on first boot: no admin
// password configured AND this server has never actually started (its
// world-save directory doesn't exist yet, so PZ has no admin account and
// would fall back to an interactive stdin prompt the panel can't answer).
// Deliberately narrower than "no admin password" alone -- an
// already-booted server has an admin account regardless of what's
// currently configured, and refusing to start THAT server over an empty
// field would be a new, unrelated regression, not a fix.
export function isFirstBootMissingAdminPassword(activeServer) {
  if (
    !activeServer ||
    activeServer.isRemote ||
    !activeServer.serverName ||
    !activeServer.zomboidDataPath ||
    activeServer.adminPassword
  ) {
    return false;
  }
  // The folder may be spelled a little differently from the configured name
  // (backupService's getSavesPath() knows the same spellings): a server whose
  // world is there has booted, and must not be refused a start for it.
  return !serverHasWorldFolder(activeServer.zomboidDataPath, activeServer.serverName);
}

// candidateIniPaths() moved to utils/zomboidPaths.js (services need it too);
// re-exported so scheduler.js and existing importers keep this path.
export { candidateIniPaths };

// Helper to auto-configure RCON in the server's .ini file
// Called BEFORE server starts to ensure PZ reads the correct RCON credentials on boot.
// If the INI file doesn't exist yet (first run), creates the directory + a minimal INI
// so PZ will merge its defaults with our RCON settings instead of generating a blank password.
// `server` is the server about to launch (refreshLaunchTargetBeforeStart()
// passes it); without one it falls back to the active server, as the
// startup-wait retry below does. A scheduled restart of a server that isn't
// the active one used to write the ACTIVE server's password into the
// active server's ini and leave its own untouched.
export async function ensureRconConfigured(server = null) {
  // Declared ahead of the try block, not inside it, so the outer catch
  // below can still reach them to build EACCES guidance -- which of the two
  // configured paths serverConfigPath actually derives from decides only
  // formatWritablePathError()'s label ("install" vs "data"); the write
  // target and the remediation are identical either way, just the noun
  // differs.
  let serverConfigPathKind = "install";
  let serverConfigPath = null;
  try {
    const activeServer = server || (await getActiveServer());
    if (!activeServer) {
      log.debug("ensureRconConfigured: No active server");
      return false;
    }

    serverConfigPathKind = activeServer.serverConfigPath ? "install" : "data";
    // SECURITY (2026-10-05, PATHS-2): this creates the folder and writes
    // the .ini (RCON password included), so a configured config folder is
    // used only while it is inside the server's own data folder
    // (utils/serverConfigPath.js) -- one saved before that check, or with
    // no data folder, is left alone and the start goes on without it. So is
    // one whose data folder fails the data-folder rule.
    //
    // SECURITY (2026-10-05, PT3/PT5): the log line says why with its code
    // and what to set (POST /start also answers it, as `folderWarning`),
    // and the startup wait calls this every 15 s, so it warns once per
    // folder and reason, then logs at debug.
    const configDir = serverConfigDirOf(activeServer);
    if (configDir.refused) {
      logRefusalOnce(
        log,
        `ensureRconConfigured: not writing RCON settings for ${activeServer.name || activeServer.serverName || "this server"} -- ${describeRefusal(serverConfigDirRefusal(configDir))}`,
      );
      return false;
    }
    serverConfigPath = configDir.dir;
    const serverName = activeServer.serverName;
    const rconPassword = activeServer.rconPassword;
    const rconPort = activeServer.rconPort || 27015;

    if (!serverConfigPath || !serverName) {
      log.debug("ensureRconConfigured: Missing serverConfigPath or serverName");
      return false;
    }

    if (!rconPassword) {
      log.debug("ensureRconConfigured: No RCON password configured");
      return false;
    }

    // A password with "=" or a line break can't be written to the .ini in a
    // form the game reads back (utils/rconPassword.js). It used to be
    // written with those characters (and ";") stripped, so the game ran on a
    // different password than the panel kept and the panel's RCON login
    // failed at every start; the .ini line, which may be what the game
    // really uses, is left as it is. A password saved before the panel
    // refused these still gets here.
    if (rconPasswordCannotBeStoredInIni(rconPassword)) {
      logRefusalOnce(
        log,
        `ensureRconConfigured: not writing the RCON password for ${activeServer.name || serverName} -- it contains "=" or a line break, or ends with a space or tab, which Project Zomboid cannot read back from server.ini (it reads a value only up to the first "=" and trims the end of the line), so the panel's RCON login would not match the game's. server.ini is left as it is; set a different RCON password for this server in the panel and in server.ini [${ErrorCode.RCON_PASSWORD_UNSUPPORTED_CHARS}]`,
      );
      return false;
    }

    // Prefer an INI that actually exists at any recognized location over
    // the default Server/ path -- see candidateIniPaths()'s comment. Falls
    // back to the default path (unchanged from before) only when none of
    // the candidates exist, which is the genuine "first run" case.
    const iniPath =
      candidateIniPaths(
        serverConfigPath,
        activeServer.zomboidDataPath,
        serverName,
      ).find((candidate) => fs.existsSync(candidate)) ||
      path.join(serverConfigPath, `${serverName}.ini`);

    // Locked per-path: two overlapping calls (e.g. a start request racing a
    // settings save) must not interleave their read-modify-write of the INI.
    return await withFileLock(iniPath, async () => {
      // If the INI doesn't exist, pre-create it with RCON settings so PZ reads them on first boot
      if (!fs.existsSync(iniPath)) {
        log.info(
          `ensureRconConfigured: INI not found — pre-creating ${iniPath} with RCON settings`,
        );
        try {
          // Ensure the Server/ directory exists
          if (!fs.existsSync(serverConfigPath)) {
            fs.mkdirSync(serverConfigPath, { recursive: true });
            log.info(`Created server config directory: ${serverConfigPath}`);
          }
          // Create minimal INI — PZ will fill in all other defaults on first boot
          const minimalIni = `# Auto-generated by Zomboid Control Panel\n# PZ will add remaining default settings on first server start\nRCONPort=${rconPort}\nRCONPassword=${rconPassword}\n`;
          writeFileAtomic(iniPath, minimalIni, {
            encoding: "utf-8",
            mode: 0o600,
          });
          log.info(`Pre-created INI with RCON settings (port: ${rconPort})`);
          return true;
        } catch (createError) {
          // Keep the raw errno in the log alongside the friendly guidance --
          // someone debugging still needs the real error, not just the
          // translation of it.
          if (createError.code === "EACCES" && serverConfigPath) {
            const guidance = formatWritablePathError(
              serverConfigPathKind,
              serverConfigPath,
            );
            log.error(
              `Failed to pre-create INI file: ${createError.message} -- ${guidance.message}`,
            );
          } else {
            log.error(`Failed to pre-create INI file: ${createError.message}`);
          }
          return false;
        }
      }

      // INI exists — check if RCON is already configured correctly
      const { content: normalized, lineEnding } = withOriginalLineEnding(
        fs.readFileSync(iniPath, "utf-8"),
      );
      let content = normalized;
      const hasCorrectPassword = hasIniKeyValue(content, "RCONPassword", rconPassword);
      const hasCorrectPort = hasIniKeyValue(content, "RCONPort", rconPort);

      if (hasCorrectPassword && hasCorrectPort) {
        log.debug("ensureRconConfigured: RCON already configured correctly");
        return true;
      }

      // Update RCON settings in the .ini file
      log.info(`Auto-configuring RCON in ${iniPath}`);

      // The password goes in as it is: it holds no line break or "=" (the
      // check above), and nothing else in a value is special to the game.
      content = setIniKeyLine(content, "RCONPassword", rconPassword);
      content = setIniKeyLine(content, "RCONPort", rconPort);

      writeFileAtomic(iniPath, restoreLineEnding(content, lineEnding), { encoding: "utf-8", mode: 0o600 });
      log.info("RCON auto-configured successfully in server .ini file");
      return true;
    });
  } catch (error) {
    if (error.code === "EACCES" && serverConfigPath) {
      const guidance = formatWritablePathError(
        serverConfigPathKind,
        serverConfigPath,
      );
      log.error(
        `ensureRconConfigured error: ${error.message} -- ${guidance.message}`,
      );
    } else {
      log.error(`ensureRconConfigured error: ${error.message}`);
    }
    return false;
  }
}

// Helper for multi-server support.
//
// split-derivation sweep, 2026-09-07 (same class as /wipe's pre-fix bug,
// 5c2e73e9): this file used to have two separate functions,
// getServerConfigPath() and getServerName(), each making its OWN
// independent getActiveServer() call. Both call sites in this file need
// both values, so a concurrent request switching the active server between
// the two separate awaited calls could produce e.g. serverConfigPath from
// server A + serverName from server B, matching neither server's real INI.
// This reads the active server ONCE and derives both values from that
// single snapshot.
// Exported so server/tests/getActiveServerPathsSingleRead.test.js can assert
// the single-read behaviour directly, rather than only indirectly through
// a route handler.
export async function getActiveServerPaths() {
  const activeServer = await getActiveServer();

  // SECURITY (2026-10-05, PATHS-2): /configure-rcon and /configure-network
  // rewrite <name>.ini in this folder, which was the record's config
  // folder or the legacy setting's, taken as is. It is now the same folder
  // Server Files and mods use (utils/serverConfigPath.js's
  // activeServerConfigDir()): a configured one only while it is inside the
  // data folder in effect, else <data folder>/Server. `configPathRefused`
  // lets those routes say which, and `configRefusal` is their answer: that
  // data folder is held to the data-folder rule there too (PATHS-1 verifier
  // pass 2), so a remote server's, never judged when saved, can't name a
  // folder here.
  const legacy = activeServer?.zomboidDataPath
    ? {}
    : {
        serverConfigPath: await getSetting("serverConfigPath"),
        zomboidDataPath: await getSetting("zomboidDataPath"),
      };
  const config = activeServerConfigDir(activeServer, legacy);
  const serverConfigPath = config.dir;

  let serverName = activeServer?.serverName || null;
  if (!serverName) {
    const legacyName = await getSetting("serverName");
    // No active server and no legacy settings name either -- "servertest"
    // used to fill in here, which is Project Zomboid's own vanilla
    // single-player/test-server name. On a machine with a real, unrelated
    // PZ install at the default path, an unconfigured panel would silently
    // target its Server/servertest.ini. Callers already gate on
    // `!serverConfigPath`; null here lets the same gate also catch "no
    // server name configured".
    serverName = legacyName || null;
  }

  return {
    serverConfigPath,
    serverName,
    configPathRefused: config.refused,
    configRefusal: config.refused ? serverConfigDirRefusal(config) : null,
  };
}

// Security: Validate server name (alphanumeric, underscore, hyphen, space allowed)
// Spaces are permitted mid-name to match PZ server names like "The Gang Goes To Louisville".
// Leading/trailing spaces are trimmed before validation.
// A client-supplied server name, trimmed once where it is read: it is the
// trimmed text isValidServerName() judges, so that same text is what must be
// used for the .ini, the start scripts and the settings.
function trimmedServerName(name) {
  return typeof name === "string" ? name.trim() : name;
}

function isValidServerName(name) {
  if (!name || typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 64) return false;
  // Must start and end with alphanumeric/underscore/hyphen; spaces allowed in the middle.
  return /^[a-zA-Z0-9_-][a-zA-Z0-9_\- ]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/.test(
    trimmed,
  );
}

// Security: Validate path is safe (no traversal, absolute path)
export function isValidPath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") return false;
  if (inputPath.includes("..")) return false;
  const normalized = path.normalize(inputPath);
  // Check for path traversal attempts
  if (normalized.includes("..")) return false;
  // Must be absolute path
  if (!path.isAbsolute(normalized)) return false;
  // SECURITY (2026-10-28): no Windows network path (//host/share, //?/UNC/...).
  // Merely touching one makes the panel's account sign in to that host,
  // handing it the account's NTLM login, and a share serves whatever files
  // it likes (utils/untrustedFolder.js). No SteamCMD or game folder is one.
  if (untrustedFolderReason(inputPath, { windows: isWindows }) === "networkShare") return false;
  return true;
}

export function resolveZomboidPaths(installPath, zomboidDataPath) {
  // path-resolution sweep, 2026-09-06: this used to be a naive template
  // string (`${installPath}_Data`), which only produces the intended
  // SIBLING folder when installPath has no trailing separator. isValidPath()
  // (above) rejects ".." and non-absolute paths but not a trailing one, and
  // path.normalize() does not strip a single trailing separator either --
  // so installPath="D:\Servers\MyServer\" (plausible from a pasted Explorer
  // address bar) silently nested the default data folder INSIDE the install
  // folder ("MyServer\_Data") instead of beside it ("MyServer_Data"), which
  // is exactly the condition the delete-files route above refuses to delete
  // through (comment at its own nested-data-path check). path.dirname() and
  // path.basename() both already strip a trailing separator before
  // extracting their piece, so deriving the default this way is
  // separator-agnostic by construction -- it doesn't matter whether
  // upstream trimmed anything, this can't reproduce the bug.
  //
  // PZ_SAVE_PATH belongs to the install PZ_SERVER_PATH names, when both are
  // set (the all-in-one image sets /pz-server and /zomboid). A second server
  // installed somewhere else gets its own sibling _Data folder, as the
  // wizard says it will: sharing the first server's data folder would make
  // both write the same server-console.txt and Logs/ while they run. The
  // wizard mirrors this rule (getEnvironmentDataPath() in the setup plan).
  const environmentDataPath = getEnvironmentDataPath();
  const envSavePathApplies =
    environmentDataPath !== null &&
    (!environmentDataPath.installPath ||
      isSameDirectory(environmentDataPath.installPath, installPath));
  const defaultZomboidDataPath = envSavePathApplies
    ? environmentDataPath.dataPath
    : path.join(path.dirname(installPath), `${path.basename(installPath)}_Data`);
  // path.resolve(): the folder as the game gets it and the profile stores it
  // (servers.js saves path.resolve() too), without a trailing separator. A
  // pasted "D:\Zomboid Data\" otherwise reached the start script as-is, where
  // its last backslash escaped the closing quote of -cachedir, and no longer
  // matched the folder the profile stores.
  const zomboidPath = path.resolve(String(zomboidDataPath || defaultZomboidDataPath));

  return {
    zomboidPath,
    serverConfigPath: path.join(zomboidPath, "Server"),
    usesEnvironmentDataPath: !zomboidDataPath && envSavePathApplies,
  };
}

// path.resolve() already drops trailing separators (keeping a bare root).
function isSameDirectory(a, b) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value));
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

function ensureWritableDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.accessSync(directoryPath, fs.constants.W_OK);
}

// `kind` selects which of the 4 WRITABLE_PATH_* codes applies -- "install"
// vs "data" is a label word choice, isContainer is a full alternate
// remediation sentence, and neither is a value to interpolate (2026-08-22
// variant-vs-params correction). Returns {message, code, params} rather
// than just the string so every call site can pass `code` and `params`
// straight through to res.json() without recomputing isContainer itself --
// the params-survive-the-formatter check this was built to satisfy.
// platformIsWindows defaults to the module's own isWindows -- container
// detection is Linux-only by design (containers aren't a Windows concept
// for this app), so a real call site never overrides it; a test does, to
// exercise the container branch on a Windows dev machine.
const WRITABLE_PATH_LABELS = Object.freeze({
  install: "Installation path",
  data: "Zomboid data folder",
});

export function formatWritablePathError(
  kind,
  directoryPath,
  platformIsWindows = isWindows,
) {
  const label = WRITABLE_PATH_LABELS[kind];
  const isContainer = !platformIsWindows && isContainerized();
  const baseMessage = `${label} is not writable: ${directoryPath}.`;

  // Wording sharpened 2026-08-29 (Linux bug hunt, "raw EACCES with no
  // pointer to the fix" card): both branches used to correctly detect the
  // problem and then explain it vaguely -- "choose a writable folder" for
  // bare metal (never says WHY this one isn't, or how to fix it in place)
  // and "make it owned by the panel container UID/GID" for Docker (never
  // names the ACTUAL knob, docker-compose.yml's own PUID/PGID env vars,
  // right above the bind-mount lines it documents). Same defect class as
  // "run as Administrator" on Linux and "pull the latest code with git" for
  // a Docker image: the refusal was correct, the instruction was not.
  if (isContainer) {
    return {
      message:
        `${baseMessage} Set PUID/PGID in your .env file to match the owner ` +
        `of this bind-mounted host folder (see docker-compose.yml's Quick ` +
        `Start), then recreate the container.`,
      code:
        kind === "install"
          ? ErrorCode.WRITABLE_PATH_INSTALL_CONTAINER
          : ErrorCode.WRITABLE_PATH_DATA_CONTAINER,
      params: { path: directoryPath },
    };
  }

  // sweep-round2, Windows non-admin install shapes (2026-09-06): this
  // branch used to be the unconditional "everything that isn't a
  // container" fallback, telling every non-container caller to fix it
  // "with chown/chmod" -- commands that don't exist on Windows. Same defect
  // class this whole function exists to have already fixed once (see the
  // 2026-08-29 comment above: "run as Administrator" on Linux, "pull the
  // latest code with git" for Docker) -- the isContainer split above never
  // covered the OS axis, only the container axis, so a non-admin Windows
  // operator pointing the install wizard's install/data path fields at a
  // folder their account can't write to (Program Files, another account's
  // profile, a UAC-protected system folder) got told to run a shell command
  // that fails outright on their OS. formatDirectoryReadError() right below
  // this function already branches on platformIsWindows for the read-side
  // equivalent of this same problem -- this mirrors that, not a new shape.
  if (platformIsWindows) {
    return {
      message:
        `${baseMessage} The Windows account running the panel does not own ` +
        `this folder or lacks write permission to it -- choose a folder ` +
        `your account can already write to (see docs/install/windows.md), ` +
        `grant your account write access via the folder's Properties > ` +
        `Security tab, or run Start.bat as Administrator.`,
      code:
        // TODO(sweep-round2, 2026-09-06): register in errorCodes.js + all 9
        // client/src/locales/*/errors.json once that directory is free
        // (another agent is mid-flight there as of this commit). Wire
        // values chosen now and won't change once registered -- until then
        // an unregistered 4xx code passes this raw message through to the
        // client untranslated rather than being silently dropped, same
        // TODO pattern already used for the auth.js escalation fix this
        // same sweep.
        kind === "install"
          ? "WRITABLE_PATH_INSTALL_WINDOWS"
          : "WRITABLE_PATH_DATA_WINDOWS",
      params: { path: directoryPath },
    };
  }

  return {
    message:
      `${baseMessage} The user running the panel does not own this folder ` +
      `or lacks write permission to it -- fix it with chown/chmod, or ` +
      `choose a folder the panel can already write to.`,
    code:
      kind === "install"
        ? ErrorCode.WRITABLE_PATH_INSTALL_BAREMETAL
        : ErrorCode.WRITABLE_PATH_DATA_BAREMETAL,
    params: { path: directoryPath },
  };
}

// Inside a container, a folder on the image's own root filesystem (not a
// volume or bind mount) can be writable and still lose everything when the
// container is recreated, which every all-in-one update does: a second
// server installed at /pz-server2 would vanish with its worlds. Refused
// before anything is created there. Returns null when the path is fine or
// when mountinfo can't tell. Three codes because each is a different
// remediation sentence; the path itself names which folder failed, so no
// install/data label is needed. `layout` is getAllInOneLayout()'s answer.
export function formatEphemeralContainerPathError(
  directoryPath,
  {
    containerized = !isWindows && isContainerized(),
    mounts,
    layout = getAllInOneLayout(),
  } = {},
) {
  if (!containerized) return null;
  if (isOnContainerRootLayer(directoryPath, mounts) !== true) return null;

  const baseMessage =
    `${directoryPath} is inside the container's own filesystem, not on a ` +
    `volume, so everything put there is erased when the container is ` +
    `recreated (every panel update does that).`;
  const root = layout?.serversRoot;
  if (root && isOnContainerRootLayer(root, mounts) === false) {
    return {
      message: `${baseMessage} Use a folder inside ${root}.`,
      code: ErrorCode.CONTAINER_PATH_NOT_PERSISTENT_AIO,
      params: { path: directoryPath, root },
    };
  }
  if (layout) {
    const suggestedRoot = root || "/pz-servers";
    return {
      message:
        `${baseMessage} This all-in-one install has no volume for extra ` +
        `servers yet: run the installer (bootstrap.sh) again to add it, then ` +
        `use a folder inside ${suggestedRoot}.`,
      code: ErrorCode.CONTAINER_PATH_NOT_PERSISTENT_AIO_NO_VOLUME,
      params: { path: directoryPath, root: suggestedRoot },
    };
  }
  return {
    message: `${baseMessage} Use a folder on a Docker volume or bind mount.`,
    code: ErrorCode.CONTAINER_PATH_NOT_PERSISTENT,
    params: { path: directoryPath },
  };
}

// isWindows picks a full alternate remediation sentence, not a value to
// interpolate -- same reasoning/shape as formatWritablePathError's
// isContainer split (2026-08-22 variant-vs-params correction). Platform is
// an explicit param (defaulting to the module's own isWindows) rather than
// read from process.platform inline, so a test can exercise both branches
// without mocking the platform for the whole module.
export function formatDirectoryReadError(
  directoryPath,
  osCode,
  platformIsWindows = isWindows,
) {
  return {
    message: platformIsWindows
      ? `Cannot read ${directoryPath} (${osCode}). Run the panel as an account that can read this folder.`
      : `Cannot read ${directoryPath} (${osCode}). The panel service account needs read and execute permission on this folder and every parent folder.`,
    code: platformIsWindows
      ? ErrorCode.DIRECTORY_READ_FAILED_WINDOWS
      : ErrorCode.DIRECTORY_READ_FAILED_POSIX,
    params: { path: directoryPath, code: osCode },
  };
}

// Shared range constants for the requireIntInRange call sites below AND in
// config.js's PUT /app-settings (which imports these rather than retyping
// the numbers). Exporting these was the actual fix for a claim made in the
// 2026-08-23 validateInt-coerces audit that turned out false: "no
// disagreement possible by construction" was said of two files with sixteen
// hand-typed literal copies of these five numbers and no shared constant
// anywhere -- true only of the FUNCTION (requireIntInRange itself,
// imported), not the ranges. A future range change is one edit here instead
// of a grep-and-hope across both files.
//
// THE PORT SPLIT, AND THE IRONY OF THIS COMMENT (GitHub #118): the fix above
// then asserted its own false claim in the very next sentence -- the
// original version of this comment said game port, RCON port and panel
// port "all mean a bindable TCP port outside the well-known range," so they
// shared one PORT_MIN/PORT_MAX pair. That is a claim about what BINDS a
// socket, and RCON does not inherently belong in it: 1024 is a bind
// constraint (opening a listening socket below it needs root on Linux), and
// nothing here about "is this port bindable" follows from a field being
// named rconPort or sftpPort. The real rule is bind vs. destination, not
// field name:
//   - BIND: a port this PANEL PROCESS itself opens and listens on -- the
//     panel's own HTTP(S) port, or the game port when the panel writes it
//     into the .ini file of a PZ server it is installing/launching on THIS
//     machine. These need BIND_PORT_MIN (1024): who's listening is us.
//   - DESTINATION: a port on someone ELSE's socket that the panel only
//     connects OUT to. SFTP is always this -- its standard port, 22, is
//     the exact value that broke here, because a destination port has no
//     reason to respect a floor that exists only to keep unprivileged
//     processes from binding low ports. DESTINATION_PORT_MIN (1) is correct
//     for it.
// RCON is conceptually a destination too (servers.js's per-server RCON
// config already treats it that way, floor 1, for the multi-server/remote
// case) -- but every RCON call site IN THIS FILE and in config.js's
// app-settings route is specifically the single legacy/locally-managed
// server's own RCON target: rconHost is resolveEnvRconHost()'s result
// (rcon.js) -- 127.0.0.1 for the usual co-located case, or the
// Docker-network address of a sibling container in the two-container
// Unraid topology -- but in either case it is THE SERVER THIS ROUTE JUST
// INSTALLED OR CONFIGURED, never an arbitrary third party the operator
// points the panel at. rcon.js's own loadConfig() documents the global
// rconHost/rconPort settings this route shares as the "legacy" fallback
// used only when no active multi-server row exists. These specific call
// sites correctly stay on BIND_PORT_MIN -- not because "RCON is bindable"
// as a category (it isn't, and servers.js's remote RCON proves it), but
// because this file's RCON port is always a port PZ itself was told to
// listen on by an install/configure flow WE ran, never a pre-existing
// destination handed to us. Decide by what a field actually points at, not
// by what it's called -- that shortcut is what let a wrong comment stand
// in as a decision for two audits in a row.
export const BIND_PORT_MIN = 1024;
export const BIND_PORT_MAX = 65535;
export const GAME_PORT_MAX = BIND_PORT_MAX - 1;
export const DESTINATION_PORT_MIN = 1;
export const DESTINATION_PORT_MAX = 65535;
export const MEMORY_GB_MIN = 1;
// A saved minimum memory may be 0, no -Xms (normalizeMinMemoryGb()). The
// active server's is mirrored into the legacy settings, which Settings' Save
// sends back whole, so /app-settings has to take it too.
export const MIN_MEMORY_GB_MIN = 0;
export const MIN_MEMORY_GB_MAX = 64;
export const MAX_MEMORY_GB_MAX = 128;

// Coerces `value` to an integer in [min, max], silently substituting
// defaultVal on NaN or out-of-range input. Despite the old name this
// function replaced ("validateInt"), it does not validate -- it never
// refuses a bad value or tells anyone it was replaced. Only use this for a
// machine-supplied or optional parameter where the substituted default IS
// the designed behaviour (e.g. a listing limit nobody typed deliberately).
// A value a human typed into a field belongs in requireIntInRange below
// instead -- see 2026-08-23 validateInt-coerces audit (server.js call sites
// were split between the two on a case-by-case basis, not a blanket switch).
function coerceIntInRange(value, min, max, defaultVal) {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < min || num > max) return defaultVal;
  return num;
}

// Parses `value` as an integer in [min, max]. Returns { ok: true, value }
// on success, or { ok: false, message } naming the field and the valid
// range on failure -- for a value a human typed into a field, where
// silently substituting something else would leave them believing they set
// something they didn't (a port they typed being silently swapped is the
// motivating case: their firewall rule and port forward end up pointing at
// a number nothing is listening on, with nothing telling them why).
export function requireIntInRange(value, min, max, fieldLabel) {
  const textValue = typeof value === "string" ? value.trim() : null;
  const num =
    typeof value === "number"
      ? value
      : textValue && /^[+-]?\d+$/.test(textValue)
        ? Number(textValue)
        : Number.NaN;
  if (!Number.isInteger(num) || num < min || num > max) {
    return {
      ok: false,
      message: `${fieldLabel} must be a whole number between ${min} and ${max}.`,
    };
  }
  return { ok: true, value: num };
}

// Build the Java classpath entries for launching the dedicated server.
// PZ's required classpath varies significantly by build/version — Build 41
// needs ~15 separate library jars listed individually under java/ (guava,
// lwjgl, javacord, sqlite-jdbc, etc.), while Build 42's shaded jar only
// needs projectzomboid.jar. Hardcoding either list breaks the other build
// with a NoClassDefFoundError (see GitHub issue #14). Instead, scan the
// java/ folder that SteamCMD actually downloaded and include every jar
// present, so the classpath always matches the installed build.
function buildClasspathEntries(installPath) {
  const entries = ["java/."];
  try {
    const javaDir = path.join(installPath, "java");
    if (fs.existsSync(javaDir)) {
      const jars = fs
        .readdirSync(javaDir)
        .filter((f) => f.toLowerCase().endsWith(".jar"))
        .sort();
      for (const jar of jars) {
        entries.push(`java/${jar}`);
      }
    }
  } catch (e) {
    log.warn(`Could not enumerate java/ jars for classpath: ${e.message}`);
  }
  // Fallback if the java/ folder wasn't found/readable (e.g. install not
  // finished yet) — matches the previous hardcoded behavior.
  if (entries.length === 1) {
    entries.push("java/projectzomboid.jar");
  }
  return entries;
}

// Generate a custom startup script with configured options
// Returns { bat: string, sh: string } with both Windows and Linux scripts
export function generateStartupScripts(options) {
  const {
    installPath,
    serverName,
    minMemory = 4,
    maxMemory = 8,
    zomboidDataPath,
    adminPassword,
    serverPort = 16261,
    useNoSteam = false,
    useDebug = false,
  } = options;

  // The server name, data folder and admin password reach the game exactly as
  // stored, each quoted for the script it goes into (utils/startScriptQuoting.js).
  // They used to be stripped of every shell metacharacter, which silently
  // pointed the game at another folder and gave it another password; a value
  // that can't be quoted (a double quote, a control character) now stops the
  // script from being generated instead.
  const nameText = String(serverName ?? "");
  const dataPathText = zomboidDataPath ? String(zomboidDataPath) : "";
  const adminPasswordText = adminPassword ? String(adminPassword) : "";
  const commentName = textForScriptComment(nameText);
  // 0 = automatic: no -Xms, so the JVM starts small and ZGC can return
  // whatever the server isn't using -- it never uncommits below -Xms.
  const normalizedMinMemory = normalizeMinMemoryGb(minMemory, 4);
  const normalizedMaxMemory = normalizeMemoryGb(maxMemory, 8);
  const minMemoryLabel = normalizedMinMemory === 0 ? "auto" : `${normalizedMinMemory}GB`;

  // ZGC grows the heap to -Xmx and is in no hurry to give it back, so a
  // generous max quietly turns into the resident set. SoftMaxHeapSize is the
  // pressure valve: GC aims to stay under it and only spends the rest of -Xmx
  // on real spikes, which keeps PZ from crowding out everything else on the
  // host. 60% of max leaves a wide burst margin.
  const softMaxMemory = Math.max(1, Math.round(normalizedMaxMemory * 0.6));

  // Build JVM arguments (shared between both platforms)
  // IgnoreUnrecognizedVMOptions first: the Linux script falls back to a system
  // JVM when jre64/ is missing, and the newer flags below are fatal on older
  // JVMs unless they're allowed to no-op.
  const jvmArgs = [
    "-XX:+IgnoreUnrecognizedVMOptions",
    "-Djava.awt.headless=true",
    useNoSteam ? "-Dzomboid.steam=0" : "-Dzomboid.steam=1",
    "-Dzomboid.znetlog=1",
    "-XX:+UseZGC",
    `-XX:SoftMaxHeapSize=${softMaxMemory}g`,
    // Return freed heap to the OS in 2 minutes instead of the 5-minute default.
    "-XX:ZUncommitDelay=120",
    // JDK 25+: 8-byte object headers. PZ's heap is millions of small objects
    // (grid squares, tile properties, items), so this is a real footprint win.
    "-XX:+UseCompactObjectHeaders",
    // Scripts/tiles/item names load a lot of duplicate strings.
    "-XX:+UseStringDeduplication",
    "-XX:-CreateCoredumpOnCrash",
    "-XX:-OmitStackTraceInFastThrow",
    ...(normalizedMinMemory > 0 ? [`-Xms${normalizedMinMemory}g`] : []),
    `-Xmx${normalizedMaxMemory}g`,
  ];

  if (useDebug) {
    jvmArgs.push("-Ddebug");
  }

  // Linux-only additions. THP cuts TLB misses on ZGC's large heap; it needs the
  // host's transparent_hugepage set to "madvise" or "always" to do anything, and
  // just logs a notice otherwise. urandom keeps startup from blocking on entropy.
  const linuxJvmArgs = [
    ...jvmArgs,
    "-XX:+UseTransparentHugePages",
    "-Djava.security.egd=file:/dev/urandom",
  ];

  // Build game arguments: the same list for both scripts, each value quoted
  // the way its script reads it (a .bat is read by cmd.exe, a .sh by bash).
  const buildGameArgs = (quote) => {
    const args = [`-servername ${quote(nameText, "The server name")}`];

    if (dataPathText) {
      args.push(`-cachedir=${quote(dataPathText, "The Zomboid data folder")}`);
    }

    if (adminPasswordText) {
      args.push(`-adminpassword ${quote(adminPasswordText, "The admin password")}`);
    }

    if (serverPort !== 16261) {
      args.push(`-port ${serverPort}`);
    }

    if (useNoSteam) {
      args.push("-nosteam");
    }
    return args;
  };
  const batchGameArgs = buildGameArgs(quoteForBatch);
  const shellGameArgs = buildGameArgs(quoteForShell);

  const classpathEntries = buildClasspathEntries(installPath);

  // Native library folders, in search order -- see
  // utils/nativeLibraryPaths.js. Linux: the install's own (server)
  // ProjectZomboid64.json when it is sane, else linux64/ first with natives/
  // behind it. Windows: the long-standing natives/;natives/win64/;., which
  // the game's own ProjectZomboidServer.bat uses too (the Windows
  // ProjectZomboid64.json is the client's). Until 2026-10-01 the .sh
  // hardcoded natives/ FIRST, so a leftover natives/ folder from an older
  // build shadowed the current linux64/ libraries and 42.21 crashed during
  // every world save.
  const windowsLibraryDirs = resolveNativeLibraryDirs(installPath, {
    platform: "win32",
  });
  const linuxLibraryDirs = resolveNativeLibraryDirs(installPath, {
    platform: "linux",
  });
  const ownPlatformDirs =
    process.platform === "win32" ? windowsLibraryDirs : linuxLibraryDirs;
  if (ownPlatformDirs.rejectedReason) {
    log.warn(
      `Not using the game's own native library path: ${ownPlatformDirs.rejectedReason}. The start script uses ${formatJavaLibraryPath(ownPlatformDirs.dirs, process.platform)} instead.`,
    );
  }
  // Shell text, expanded by bash when the script runs (escaped \${...}).
  const linuxLdLibraryPath = [
    ...formatShellLibraryDirs(linuxLibraryDirs.dirs),
    `\${INSTDIR}`,
    `\${INSTDIR}/jre64/lib/amd64`,
    `\${INSTDIR}/jre64/lib/x86_64`,
    "/usr/lib64",
    `\${LD_LIBRARY_PATH}`,
  ].join(":");

  // Windows batch file
  // disabledelayedexpansion: with it on (a machine-wide default some hosts
  // set) cmd.exe would eat the !...! in a path or password.
  const batchContent = `@echo off
@setlocal enableextensions disabledelayedexpansion
@cd /d "%~dp0"

REM =====================================================
REM Project Zomboid Server Startup Script
REM Generated by PZ Server Manager
REM Server Name: ${commentName}
REM Memory: ${minMemoryLabel} - ${normalizedMaxMemory}GB
REM =====================================================

SET PZ_CLASSPATH=${classpathEntries.join(";")}

".\\jre64\\bin\\java.exe" ${jvmArgs.join(" ")} -Djava.library.path=${formatJavaLibraryPath(windowsLibraryDirs.dirs, "win32")} -cp %PZ_CLASSPATH% zombie.network.GameServer ${batchGameArgs.join(" ")}

PAUSE
`;

  // Linux shell script
  const shellContent = `#!/bin/bash
cd "\$(dirname "\$0")"

# =====================================================
# Project Zomboid Server Startup Script
# Generated by PZ Server Manager
# Server Name: ${commentName}
# Memory: ${minMemoryLabel} - ${normalizedMaxMemory}GB
# =====================================================

PZ_CLASSPATH="${classpathEntries.join(":")}"

JAVA_CMD="./jre64/bin/java"
if [ ! -f "$JAVA_CMD" ]; then
  # Try common system Java locations (CentOS, Ubuntu, etc.)
  for JPATH in /usr/bin/java /usr/local/bin/java /usr/lib/jvm/jre/bin/java; do
    if [ -f "$JPATH" ]; then
      JAVA_CMD="$JPATH"
      break
    fi
  done
  if [ ! -f "$JAVA_CMD" ]; then
    JAVA_CMD="java"
  fi
fi

# Verify Java is actually available
if ! command -v "$JAVA_CMD" >/dev/null 2>&1; then
  echo "ERROR: Java not found. Install OpenJDK: sudo yum install java-17-openjdk (CentOS) or sudo apt install openjdk-17-jre (Ubuntu)"
  exit 1
fi

INSTDIR="$(dirname "$0")"
export LD_LIBRARY_PATH="${linuxLdLibraryPath}"

"$JAVA_CMD" ${linuxJvmArgs.join(" ")} -Djava.library.path=${formatJavaLibraryPath(linuxLibraryDirs.dirs, "linux")} -cp "$PZ_CLASSPATH" zombie.network.GameServer ${shellGameArgs.join(" ")}
`;

  return { bat: batchContent, sh: shellContent };
}

// Filename for the per-install sidecar that records the hash of the content
// THIS PANEL last wrote to each startup script. Kept next to the scripts
// rather than a new DB column -- no migration, and it travels naturally with
// a moved/copied install directory the same way the scripts themselves do.
const SCRIPT_FINGERPRINT_FILE = ".pz-panel-scripts.json";

function hashScriptContent(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Regenerate the panel-managed startup script(s), but never let a
 * regeneration silently discard content the panel didn't itself last write.
 *
 * `files` is `[{ path, content }, ...]`. For each: if a file already exists
 * at that path AND its current on-disk hash doesn't match the fingerprint
 * recorded the last time THIS function wrote it, the existing file is backed
 * up (timestamped, alongside the original) before being overwritten. Config
 * changes still always take effect -- every file is written through
 * regardless -- only the decision to back up first depends on provenance.
 *
 * A MISSING fingerprint (no sidecar at all -- true for every install that
 * predates this fix, i.e. the entire upgrade population) is deliberately
 * treated the same as a mismatch, not as "assume unmodified": we cannot
 * prove a pre-fingerprint file is still the panel's own untouched output, so
 * the safe default is one harmless backup on the first post-upgrade start
 * rather than risking a silent clobber of a real hand-edit. A backup nobody
 * needed is a small, one-time cost; treating unknown provenance as safe is
 * exactly the bug this exists to fix.
 *
 * Backups are never pruned -- an unbounded folder of .bak files is a smaller
 * problem than data loss, and every install already has an operator who can
 * clean them up manually. Deliberate choice, not an oversight.
 *
 * Returns `backupMessages`, human-readable, one per file that was backed up
 * (empty if none were), and `failedPaths`, every file it could not write.
 * Never throws for a single file's backup, read or write failure -- that
 * file's regeneration still proceeds, or is skipped, with a warning logged
 * server-side, since "config changes take effect" must not depend on the
 * backup step succeeding. `failedPaths` is how the caller knows a write
 * failed without a throw (GH #167: the refresh used to log "Regenerated
 * startup scripts" right after a failed write, next to the refusal it
 * then caused).
 */
export function writeStartupScriptsWithBackup(installPath, files) {
  const fingerprintPath = path.join(installPath, SCRIPT_FINGERPRINT_FILE);
  let fingerprints = {};
  try {
    fingerprints = JSON.parse(fs.readFileSync(fingerprintPath, "utf8"));
  } catch {
    fingerprints = {}; // missing/corrupt sidecar -- treated as "no known-good fingerprints" below
  }

  const backupMessages = [];
  const failedPaths = [];
  for (const { path: filePath, content } of files) {
    const fileName = path.basename(filePath);
    let existingContent = null;
    try {
      existingContent = fs.readFileSync(filePath, "utf8");
    } catch {
      existingContent = null; // no prior file -- first-ever generation, nothing to protect
    }

    if (existingContent !== null) {
      const knownHash = fingerprints[fileName];
      const currentHash = hashScriptContent(existingContent);
      if (!knownHash || knownHash !== currentHash) {
        // toISOString() is millisecond-resolution, and two regenerations detected close
        // together (e.g. two hand-edits regenerated back to back in the same test, or two
        // rapid Starts) can land in the same millisecond -- especially on a fast filesystem
        // -- which would make the second backup silently overwrite the first. Disambiguate
        // with a counter suffix so two backups from the same tick never collide.
        let backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        if (fs.existsSync(backupPath)) {
          let suffix = 2;
          while (fs.existsSync(`${backupPath}-${suffix}`)) suffix++;
          backupPath = `${backupPath}-${suffix}`;
        }
        try {
          fs.copyFileSync(filePath, backupPath);
          // The copy keeps the source's mode, and a script from before #193
          // may still be world-readable -- the backup carries the same
          // -adminpassword, so it is owner-only whatever the source was.
          try {
            fs.chmodSync(backupPath, 0o600);
          } catch {
            /* best effort: Windows has no POSIX modes to tighten */
          }
          backupMessages.push(
            `${fileName} had content the panel didn't last write (a hand-edit, or an install from before this backup existed) -- your version was saved to ${path.basename(backupPath)} before regenerating.`,
          );
        } catch (backupErr) {
          log.warn(
            `Could not back up ${filePath} before regenerating: ${backupErr.message}`,
          );
        }
      }
    }

    try {
      // Both scripts embed -adminpassword. An explicit mode also tightens a
      // .bat written before #193 (writeFileAtomic otherwise keeps an existing
      // file's mode), since every Start regenerates it here.
      writeFileAtomic(
        filePath,
        content,
        filePath.endsWith(".sh")
          ? { encoding: "utf8", mode: 0o750 }
          : { encoding: "utf8", mode: 0o600 },
      );
      fingerprints[fileName] = hashScriptContent(content);
    } catch (writeErr) {
      failedPaths.push(filePath);
      log.warn(`Could not write ${filePath}: ${writeErr.message}`);
    }
  }

  try {
    writeFileAtomic(
      fingerprintPath,
      JSON.stringify(fingerprints, null, 2),
      "utf8",
    );
  } catch (fpErr) {
    log.warn(`Could not persist script fingerprint file: ${fpErr.message}`);
  }

  return { backupMessages, failedPaths };
}

// writeStartupScriptsWithBackup() for callers that only want the backup
// notices -- its shape before failed writes were reported.
export function regenerateStartupScriptsWithBackup(installPath, files) {
  return writeStartupScriptsWithBackup(installPath, files).backupMessages;
}

// Role sweep for this file: routes below are grouped into what's actually
// operational duty (start/stop/restart/save the running process, install or
// update the game, edit its .ini config, browse the filesystem to set that
// up) vs. what's read-only status/info or in-game/GM authority that every
// role legitimately uses. Wipe and delete-files stay admin-only, unchanged.
//
// UPDATE: the weather/events/alarm/message/removezombies/releasesafehouse
// group below, previously left open with no gate at all (every signed-in
// role reached them, same as any other GM tool), is now
// requirePermission("server.world_events") -- folded into the matrix and
// granted to admin+technician+moderator by default, so this is a zero-
// behaviour-change addition, not a restriction (adding a capability isn't
// narrowing anything). Only /status and /network-interfaces stay
// deliberately outside the matrix entirely: dashboard-wide reads that
// protect nothing if gated and can break a screen for a role if mis-set.
// Everything left unguarded below is that deliberate exception, not an
// oversight.

// Get server status
router.get("/status", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");
    log.debug("GET /status");

    const status = await serverManager.getServerStatus();
    const rconStatus = rconService.getConfig();

    res.json({
      // The install folder only for a role that sets it up
      // (utils/hostPathView.js); serverPathConfigured still says whether
      // there is one.
      ...((await canSeeHostPaths(req.user)) ? status : hideHostPaths(status)),
      // Whether RCON is connected for every role; its host and port only
      // for the roles that work with it (utils/rconTargetView.js).
      rcon: (await canSeeRconTarget(req.user)) ? rconStatus : withoutRconConfigTarget(rconStatus),
      // For the client to re-express startTime in its own clock -- see
      // routes/serverStatus.js, which sends the same field.
      serverTime: Date.now(),
    });
  } catch (error) {
    log.error(`Failed to get server status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// List every non-internal IPv4 address the host currently has (one per
// network adapter/VPN mesh) so Settings can offer a picker instead of the
// dashboard guessing which one to show.
router.get("/network-interfaces", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    res.json({ interfaces: serverManager.listNetworkInterfaces() });
  } catch (error) {
    log.error(`Failed to list network interfaces: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Refresh everything PZ needs to launch correctly against this server's
// CURRENT settings: RCON credentials in the ini, and the generated launch
// script (which bakes -cachedir/-servername/memory/admin-password as
// literal text at generation time -- see generateStartupScripts()).
//
// GH #167: called from ONE place now, lifecycleCoordinator.prepareForLaunch()
// (wired in server/index.js), which serverManager.startServer() and the two
// Docker-managed launch paths run right before launching -- so the boot
// auto-start, Discord, mod-update and post-update starts refresh exactly the
// way the dashboard's Start does. It used to be called by the /start route
// and scheduler.js's performRestart() only: the auto-start launched the stock
// start-server.sh on a fresh install and kept old RCON/admin passwords after
// an edit, and a Docker-managed server got its RCON password only after the
// container had already booted. Before this existed at all, a
// Settings-UI edit to zomboidDataPath/serverName updated the database
// immediately but left the already-written launch script untouched until
// the next MANUAL start regenerated it -- the next SCHEDULED restart in
// between launched PZ against the OLD baked cachedir, PZ found no ini at
// that (now-wrong) location, and generated itself a fresh default one
// (2026-08-27, user-report-servertest-ini-and-sandbox-reverted-to-default-
// after-restart, loonE/Discord -- root cause confirmed by Jim's
// scheduledRestartStaleLaunchScript.test.js reproduction).
//
// `managedHandled` mirrors the /start route's own `managed.handled` check:
// a container-managed server's image owns the launch command, so there is
// no local script to regenerate.
//
// Operator ruling 2026-08-27 (custom-launcher-as-a-real-supported-mode-not-
// an-accident): a stored serverPath/installPath ending in .bat/.sh/.exe is
// CUSTOM LAUNCHER mode, not an error -- resolveLaunchMode() (serverManager.js)
// is the one predicate both this function AND serverManager.loadConfig() (to
// pick the script it launches) ask, so the two agree on what "managed" means
// without either growing its own notion of it.
export async function refreshLaunchTargetBeforeStart(
  activeServer,
  { managedHandled = false, platform = process.platform } = {},
) {
  try {
    const rconReady = await ensureRconConfigured(activeServer);
    if (rconReady) {
      log.info("RCON pre-configured in INI before server start");
    } else {
      // No "will retry" here: this runs before every launch path, and only
      // POST /start's waitForRconAfterStart() tries ensureRconConfigured()
      // again -- the boot auto-start, the scheduler, Discord and post-update
      // starts don't. ensureRconConfigured() logs its own reason (no RCON
      // password set, no ini folder or server name, or the write error).
      log.warn(
        "Could not pre-configure RCON in the server's ini before this start -- the game uses the RCON settings already in it",
      );
    }
  } catch (rconErr) {
    log.warn(`RCON pre-configuration failed: ${rconErr.message}`);
  }

  let scriptBackupWarnings = [];
  // Whether this launch runs a start script the panel wrote just now (and
  // so loads linux64/ first), for the leftover-natives warning below.
  let wroteLaunchedScript = false;
  const launchMode = resolveLaunchMode(activeServer);
  // The folder the game is launched from: `serverPath || installPath`, the
  // same one serverManager.loadConfig() spawns in and checks for the named
  // script, and the one a systemd/OpenRC unit runs it from
  // (linuxServiceLifecycle.js's resolveLaunchTarget()). The scripts used to
  // be written into installPath alone, so a record with a separate
  // serverPath folder never launched what was written here.
  const launchDir = activeServer?.serverPath || activeServer?.installPath;
  const panelLaunches =
    !managedHandled && activeServer && !activeServer.startCommand && launchDir;
  if (panelLaunches && launchMode.mode === "custom") {
    // CUSTOM LAUNCHER mode (operator ruling 2026-08-27): the panel does not
    // manage this script. Regenerating would join a filename onto the
    // launcher PATH itself (launchDir here is a file, not a directory)
    // and either write into a broken nested path or silently do nothing --
    // neither is "not regenerating," so this must not even attempt the
    // write, unlike before this feature existed.
    log.info(
      `Custom launcher mode active (${launchMode.launcherPath}) — not regenerating; the panel does not manage this script.`,
    );
  } else if (
    panelLaunches &&
    // No name, no named script to write (it would be
    // StartServer_undefined.bat); such a server launches the stock one.
    activeServer.serverName
  ) {
    try {
      const scripts = generateStartupScripts({
        installPath: launchDir,
        serverName: activeServer.serverName,
        // ?? and not ||: 0 is a minimum of its own (no -Xms).
        minMemory: activeServer.minMemory ?? 4,
        maxMemory: activeServer.maxMemory || 8,
        zomboidDataPath: activeServer.zomboidDataPath || "",
        adminPassword: activeServer.adminPassword || "",
        serverPort: activeServer.serverPort || 16261,
        useNoSteam: activeServer.useNoSteam || false,
        useDebug: activeServer.useDebug || false,
      });
      const batPath = path.join(
        launchDir,
        managedStartupScriptName(activeServer.serverName, true),
      );
      const shPath = path.join(
        launchDir,
        managedStartupScriptName(activeServer.serverName, false),
      );
      const { backupMessages, failedPaths } = writeStartupScriptsWithBackup(
        launchDir,
        [
          { path: batPath, content: scripts.bat },
          { path: shPath, content: scripts.sh.replace(/\r\n/g, "\n") },
        ],
      );
      scriptBackupWarnings = backupMessages;
      if (scriptBackupWarnings.length > 0) {
        log.warn(
          `Startup script regeneration backed up existing content: ${scriptBackupWarnings.join(" ")}`,
        );
      }
      // Success is logged only when both files were written. A failed write
      // used to be followed by "Regenerated startup scripts ..." anyway,
      // right before the start's SERVER_START_SCRIPT_MISSING refusal that
      // sends the operator to this log (GH #167). The launcher this
      // platform runs decides what a failure means for the start that
      // follows.
      const launched = managedStartupScriptName(activeServer.serverName);
      const launchedPath = path.join(launchDir, launched);
      wroteLaunchedScript = !failedPaths.includes(launchedPath);
      if (failedPaths.length === 0) {
        log.info("Regenerated startup scripts with current server config");
      } else if (!failedPaths.includes(launchedPath)) {
        log.warn(
          `Regenerated ${launched}, but not ${failedPaths.map((failed) => path.basename(failed)).join(", ")} (see the warning above)`,
        );
      } else if (fs.existsSync(launchedPath)) {
        log.warn(
          `Could not regenerate ${launched} (see the warning above) -- this start runs the copy already in ${launchDir}, which may carry older settings`,
        );
      } else {
        log.warn(
          `Could not write ${launched} (see the warning above) -- the start refuses to run without it until the panel can write to ${launchDir}`,
        );
      }
    } catch (scriptErr) {
      log.warn(`Could not regenerate startup scripts: ${scriptErr.message}`);
    }
  }
  if (!managedHandled && activeServer && !activeServer.isRemote) {
    await warnAboutLeftoverNativeLibraries(activeServer, platform, {
      panelScript:
        wroteLaunchedScript &&
        launchesPanelStartScript(activeServer, { windows: platform === "win32" }),
    });
  }
  return { scriptBackupWarnings };
}

// Logs, before every launch the panel performs, the leftover natives/ folder
// that crashed 42.21 during world saves (utils/nativeLibraryPaths.js). The
// panel's own script no longer loads it first, but a custom launcher, a
// custom start command, a hand-edited script or a ProjectZomboid64.json
// that lists natives/ first still can -- and nothing else would tell the
// operator why. `panelScript` (this launch runs the script just written)
// picks the wording: only then can the line say what the launch loads.
// Never deletes or renames anything, never blocks the launch.
async function warnAboutLeftoverNativeLibraries(server, platform, { panelScript }) {
  const gameDir = resolveGameDirForNativeCheck(server);
  if (!gameDir) return;
  try {
    const leftover = await detectLeftoverNativeLibraries(gameDir, { platform });
    if (leftover) {
      log.warn(describeLeftoverNativeLibraries(gameDir, leftover, { panelScript }));
    }
  } catch (error) {
    log.debug(`Native library check skipped: ${error.message}`);
  }
}

// What lifecycleCoordinator.prepareForLaunch() runs (wired in server/index.js
// with setLaunchTargetRefresher()). `server` is whatever record the launching
// code holds -- for the shared ServerManager, the one it loaded at boot or on
// the last server switch, which an edit of the RCON or admin password alone
// doesn't reload (GH #167's follow-up: a restart of the panel's container
// brought the game back with the OLD passwords). So the record is read
// again by id and the refresh uses that; the passed one is only a fallback
// for a record with no id or a failed read. A remote server is never
// launched by the panel, so there is nothing to refresh for one.
export async function refreshLaunchTargetForLaunch(server, options = {}) {
  let current = server;
  if (server?.id !== null && server?.id !== undefined) {
    try {
      current = (await getServer(server.id)) || server;
    } catch {
      current = server;
    }
  }
  if (!current || current.isRemote) return null;
  return refreshLaunchTargetBeforeStart(current, options);
}

// Once the process/container is confirmed running, wait for RCON to come up
// (PZ takes 60-180s to fully start) by polling for the port rather than
// blindly waiting, and clear serverStarting when done either way. Shared by
// both the native/managed-lifecycle path (called once the 1s scan-poll below
// confirms isRunning) and the Docker path (called immediately, since Docker's
// own start action already confirms the container is up -- see the /start
// handler's own comment).
async function waitForRconAfterStart({ rconService, discordBot }) {
  log.info("Waiting for RCON to be ready - starting port polling...");

  await rconService.loadConfig(); // Ensure clean config
  const rconHost = rconService.config.host || "127.0.0.1";
  const rconPort = rconService.config.port || 27015;
  log.info(`Monitoring TCP port ${rconHost}:${rconPort} for activity...`);

  let rconConnected = false;
  let rconConfigured = false;
  let portOpen = false;

  // Poll port for up to 5 minutes (300 seconds) - checking every 5 seconds
  const maxPollAttempts = 60;

  for (let i = 0; i < maxPollAttempts; i++) {
    // 1. Check if port is open (if not already found)
    if (!portOpen) {
      portOpen = await rconService.checkPortOpen(rconHost, rconPort);

      if (!portOpen) {
        log.debug(
          `RCON startup: Port ${rconHost}:${rconPort} not yet open (poll ${i + 1}/${maxPollAttempts})...`,
        );
        // Wait 5 seconds before next check
        await new Promise((r) => setTimeout(r, 5000));

        // Periodically try to configure RCON (Wait for .ini to appear)
        if (!rconConfigured && i % 3 === 0) {
          // Every 15s (3 * 5s)
          rconConfigured = await ensureRconConfigured();
          if (rconConfigured) {
            log.info(
              "RCON settings auto-configured in server .ini file during startup wait",
            );
          }
        }
        continue;
      }
      log.info(
        `RCON port ${rconHost}:${rconPort} is now open! Initiating connection...`,
      );
    }

    // 2. Port is open, try to connect
    // Reset connection state before attempt to clear any stalled state
    if (rconService.forceResetConnectionState) {
      rconService.forceResetConnectionState();
    }

    try {
      // Attempt connection with a 15s timeout
      const connectPromise = rconService.connect();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Connection attempt timed out after 15s")),
          15000,
        ),
      );

      await Promise.race([connectPromise, timeoutPromise]);

      if (rconService.connected) {
        log.info("RCON connected successfully after server startup");
        rconConnected = true;
        break;
      } else {
        log.warn(
          `RCON connected to port but authentication/handshake failed. Retrying...`,
        );
        // Wait a bit before retry if port is open but auth fails (service might be starting up)
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (e) {
      log.warn(`RCON connection attempt failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // Log completion status
  if (rconConnected) {
    log.info("RCON startup sequence completed - connected");
    discordBot
      ?.sendEventNotification("serverStart", {})
      .catch((err) =>
        log.debug(`Discord serverStart notification failed: ${err.message}`),
      );
  } else {
    log.warn(
      "RCON startup sequence completed - NOT connected (auto-reconnect will keep trying every 30s)",
    );
  }

  // Clear the flag when done - now auto-reconnect can take over
  if (rconService.setServerStarting) {
    rconService.setServerStarting(false);
  } else {
    rconService.serverStarting = false;
  }
}

// Start server
router.post("/start", requirePermission("server.control"), async (req, res) => {
  // Fetched before acquiring the lock (a pure DB read, no lock needed for
  // it) purely so a refusal from a concurrent operation can name which
  // server it's for -- see lifecycleCoordinator.js's comment.
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "start",
    activeServerForLock?.id ?? null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  let lifecycleLockTransferred = false;
  let lifecycleLockReleased = false;
  // Once the process is up, the wait for RCON holds this server only
  // (holdServerUntilRcon): the other servers can start and stop meanwhile.
  let rconHold = null;
  const releaseLifecycleLock = () => {
    if (lifecycleLockReleased) return;
    lifecycleLockReleased = true;
    lifecycleLock.release();
    rconHold?.release();
  };
  try {
    const activeServer = activeServerForLock;
    log.info(
      `POST /start (server=${activeServer?.name || "unknown"}, remote=${activeServer?.isRemote || false})`,
    );
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Cannot start a remote server. Remote servers are managed externally — use RCON to interact.",
        code: ErrorCode.SERVER_START_REMOTE_REFUSED,
      });
    }

    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");

    // The launch target (RCON credentials in the ini, the generated launch
    // script) and PanelBridge are brought up to date by the before-launch
    // step inside both launch paths below -- runManagedLifecycle() and
    // serverManager.startServer() -- so the boot auto-start and scheduled,
    // Discord and mod-update restarts get exactly what this route gets
    // (lifecycleCoordinator.prepareForLaunch()).

    // A container-managed server is started through Docker: the panel has no
    // process to spawn, and after a `docker stop` there is nothing left running
    // for it to reattach to.
    const managed = await runManagedLifecycle("start", {
      serverId: activeServer?.id ?? null,
    });
    if (managed.handled && !managed.success) {
      return res.status(502).json({ error: sanitizeError(managed.error) });
    }
    if (managed.alreadyRunning) {
      return res.json(managed);
    }

    // A server that has never booted has no world database and no admin
    // account yet -- PZ creates the admin account interactively on exactly
    // that first boot, prompting on stdin if -adminpassword isn't set. The
    // panel spawns it with no interactive stdin, so it hangs on
    // Scanner.nextLine() and dies with an unreadable
    // java.util.NoSuchElementException, well after this response is long
    // gone (2026-08-26, two independent real-user reports: a server created
    // through the setup wizard could not start at all, because
    // createServer() silently dropped adminPassword on create -- fixed
    // separately in database/init.js -- and nothing here ever refused to
    // launch a server it knew was about to hit this). Scoped to first boot
    // specifically (world save directory absent), not every start with an
    // empty admin password: an already-booted server already has an admin
    // account and genuinely doesn't need this flag to start cleanly.
    if (!managed.handled && isFirstBootMissingAdminPassword(activeServer)) {
      return res.status(400).json({
        error:
          `${activeServer.name || activeServer.serverName} has never started before and has no admin password set. ` +
          `Project Zomboid needs one to create the admin account on first boot, or the server process hangs waiting ` +
          `for console input that will never come and crashes. Set an admin password for this server (My Servers → ` +
          `${activeServer.name || activeServer.serverName} → Admin Password), then try starting again.`,
      });
    }

    // startServer() refreshes the launch target itself and carries any
    // script backup notices back as result.scriptWarnings.
    // ignoreUnknownState: the operator confirmed "start anyway" after a
    // SERVER_START_STATE_UNKNOWN refusal. It only waives the failed process
    // scan; every other guard in startServer() (already running, RCON and
    // game ports in use, ...) still applies.
    const launched = managed.handled
      ? { success: true, message: managed.message || "Container starting" }
      : await serverManager.startServer({
          serverId: activeServer?.id ?? null,
          ignoreUnknownState: req.body?.ignoreUnknownState === true,
        });
    // SECURITY (2026-10-05, PT3): with the server's folders refused (a data
    // folder that no longer meets the data-folder rule, or a config folder
    // with no data folder), the start goes ahead without the RCON settings
    // ensureRconConfigured() writes, which only the log used to say. The
    // refusal goes back with the start as `folderWarning` (its code, and
    // what to set) for the Dashboard to show. A copy, as with
    // scriptWarnings, so a provider's own result is never mutated.
    const folderWarning = serverFolderProblem(activeServer);
    const result = folderWarning ? { ...launched, folderWarning } : launched;

    // Emit status update via Socket.IO
    const io = req.app.get("io");

    // Set flag to prevent RCON reconnect attempts during startup
    // Use setServerStarting which has a 5-minute failsafe timeout
    if (rconService.setServerStarting) {
      rconService.setServerStarting(true);
    } else {
      rconService.serverStarting = true;
    }

    // Docker's own start action already confirms the container is up before
    // runManagedLifecycle() returns (dockerClient.js's lifecycleTimeoutMs
    // comment: "Docker answers only once the action completes") -- unlike
    // the native path below, there is nothing further to poll for. The
    // scan-poll below is ALSO a local host process scan, which for a
    // container-managed server can never see PZ running as PID 1 of a
    // *different* container (GH#114) -- polling it here would just run for
    // 30s and always time out, exactly the gap this fix closes. Emit
    // immediately and go straight to waiting for RCON, skipping the poll
    // entirely for this path.
    if (managed.handled) {
      // Not a bare io.emit("server:status", {running:true}) -- the host
      // (container) being confirmed up is not the same claim as the server
      // being ready to use, and RCON can still take well past this moment to
      // come up (waitForRconAfterStart below). checkServerStatusNow is the
      // sole place that computes the starting/running/unresponsive phase
      // (see resolveServerPhase's own comment) from rconService.serverStarting,
      // which was just set true above -- asserting our own competing
      // {running:true} here would reintroduce the exact premature-green-dot
      // bug this fix exists to close.
      const checkServerStatusNow = req.app.get("checkServerStatusNow");
      if (typeof checkServerStatusNow === "function") {
        Promise.resolve(checkServerStatusNow("start-managed")).catch((err) =>
          log.debug(`Post-start status re-check failed: ${err.message}`),
        );
      } else if (io) {
        io.emit("server:status", { running: true });
      }
      log.info("Container start confirmed by Docker; skipping local process poll");
      lifecycleLockTransferred = true;
      rconHold = holdServerUntilRcon(lifecycleLock);
      void waitForRconAfterStart({
        rconService,
        discordBot: req.app.get("discordBot"),
      })
        .catch((err) =>
          log.error(`Post-start RCON wait failed: ${err.message}`),
        )
        .finally(() => {
          // Nudge for the running/unresponsive transition the instant
          // waitForRconAfterStart settles, rather than leaving it to the
          // periodic watchdog's own next tick (up to 10s later).
          if (typeof checkServerStatusNow === "function") {
            Promise.resolve(checkServerStatusNow("start-managed-rcon-settled")).catch(
              (err) => log.debug(`Post-start status re-check failed: ${err.message}`),
            );
          }
          releaseLifecycleLock();
        });
      res.json(result);
      return;
    }

    // Poll for server to actually be running (takes a few seconds to start).
    // One scan at a time: each check schedules the next only once its own
    // scan has settled. This was setInterval(async ..., 1000), whose ticks
    // never waited for each other -- a Windows process scan takes longer
    // than 1s, so two or three ticks were in flight at once, each saw
    // running:true after the first had already stopped the interval, and
    // each started its own waitForRconAfterStart(). Those waiters then
    // force-reset each other's RCON connection (2026-09-28 live Workshop
    // test on 42.21: three "Server detected as running" a second apart,
    // then "Connection attempt cancelled (force reset occurred)" and the
    // phase flapping running/unresponsive), and each one sent its own
    // Discord serverStart notice. The 30s budget is elapsed time, as it was
    // with the interval, so a slow scan doesn't stretch it to 30 scans --
    // performance.now(), which a wall-clock step can't move: the poll holds
    // the lifecycle lock, which has no expiry, so Stop and Restart would
    // answer 409 for as long as a backward step added.
    const pollDeadline = performance.now() + 30000; // 30 seconds max
    const endStartingWindow = () => {
      if (rconService.setServerStarting) {
        rconService.setServerStarting(false);
      } else {
        rconService.serverStarting = false;
      }
    };

    const pollOnce = async () => {
      try {
        // checkServerRunning() collapses a failed detection scan into a
        // bare `false`, indistinguishable from "confirmed not yet running"
        // -- hardcoding scanFailed: false here made that same mistake one
        // layer up, by asserting a clean result the check never actually
        // produced. getServerProcessDetails() is unconditionally present on
        // the real ServerManager, so this branch is currently unreachable;
        // treat "no richer check available" as its own scan failure so a
        // lighter serverManager wired up later still keeps polling/times
        // out with a warning instead of the poll declaring the server never
        // came up while it may simply be unable to tell (2026-08-26 bug
        // hunt finding 3 -- same class already fixed at lines 2901, 3516,
        // 4608 in this file).
        const processDetails =
          typeof serverManager.getServerProcessDetails === "function"
            ? await serverManager.getServerProcessDetails()
            : { running: false, scanFailed: true };
        const timedOut = performance.now() >= pollDeadline;

        if (!processDetails || processDetails.scanFailed) {
          if (timedOut) {
            releaseLifecycleLock();
            endStartingWindow();
            log.warn(
              "Server start polling timed out without confirming process state",
            );
            return;
          }
          setTimeout(pollOnce, 1000);
          return;
        }

        const isRunning = Boolean(processDetails.running);

        if (isRunning) {
          // See the managed branch's own comment above: the host process
          // existing is not the same claim as the server being ready, so
          // this asks checkServerStatusNow to compute the real phase
          // (starting, since rconService.serverStarting is still true here)
          // instead of asserting a bare running:true directly.
          const checkServerStatusNow = req.app.get("checkServerStatusNow");
          if (typeof checkServerStatusNow === "function") {
            Promise.resolve(checkServerStatusNow("start-detected")).catch((err) =>
              log.debug(`Post-start status re-check failed: ${err.message}`),
            );
          } else if (io) {
            io.emit("server:status", { running: true });
          }
          log.info("Server detected as running");
          rconHold = holdServerUntilRcon(lifecycleLock);
          await waitForRconAfterStart({ rconService, discordBot: req.app.get("discordBot") });
          // Nudge for the running/unresponsive transition the instant
          // waitForRconAfterStart settles, rather than leaving it to the
          // periodic watchdog's own next tick (up to 10s later).
          if (typeof checkServerStatusNow === "function") {
            Promise.resolve(checkServerStatusNow("start-rcon-settled")).catch((err) =>
              log.debug(`Post-start status re-check failed: ${err.message}`),
            );
          }
          releaseLifecycleLock();
        } else if (timedOut) {
          releaseLifecycleLock();
          endStartingWindow();
          log.warn("Server start polling timed out");
        } else {
          setTimeout(pollOnce, 1000);
        }
      } catch (err) {
        // No next check is scheduled after an error, so the poll ends here.
        releaseLifecycleLock();
        endStartingWindow();
        log.error(`Server status poll failed: ${err.message}`);
      }
    };
    setTimeout(pollOnce, 1000);
    lifecycleLockTransferred = true;

    // Send immediate response
    res.json(result);
  } catch (error) {
    log.error(`Failed to start server: ${error.message}`);
    // startServer()'s coded refusals (SERVER_START_SCRIPT_MISSING, GH #167;
    // SERVER_START_GAME_PORT_IN_USE) -- registered codes, so the dashboard
    // shows them in the operator's language. The same list a failed
    // Restart's action result forwards (routes/scheduler.js's
    // codedActionResultFields()), so the two can't drift. Any other error
    // (e.g. a raw fs "ENOENT") keeps the plain-message shape.
    const body = {
      error: sanitizeError(error.message),
      ...codedActionResultFields(error),
    };
    res.status(500).json(body);
  } finally {
    if (!lifecycleLockTransferred) releaseLifecycleLock();
  }
});

// The panel has just confirmed the active game server gone: a Docker or
// systemd/openrc stop that only returns once it is, a kill that
// serverManager.stopServer() confirmed, or the graceful-stop poll's
// completed scan no longer finding the process. The mod's last status.json
// write is from that process, so expire it now (PanelBridge.markServerExited())
// instead of leaving it to the watchdog, which only does so on a stopped
// VERDICT -- and while that heartbeat still read live, the verdict itself
// ORed it back in as "running" whenever the host signal was not the final
// word (a scan that failed right after the stop, a systemd server the plain
// scan answered for), so PanelBridge Up and Stop stayed on screen for up to
// five minutes. Called before checkServerStatusNow() so that re-check, and
// the composed status every client refetches on its push, already read
// PanelBridge offline.
function expireExitedServerHeartbeat() {
  panelBridge.markServerExited();
}

// Stop and Force stop must work while a restart is running: a restart holds the
// one process-wide lifecycle lock for its whole run (a countdown of up to an
// hour, then the stop, the start and the wait for RCON), so both used to be
// refused with "A 'restart' operation ... is already in progress" and the only
// way to turn the server off was to restart the panel. They now cancel the
// restart (every wait in it ends at once and no step after it is taken) and
// take the lock when it frees. A restart that is stuck in a step that cannot be
// interrupted (the Docker restart call, the launch itself) is taken over after
// RESTART_CANCEL_WAIT_MS: its own release() then does nothing. Any other
// holder (a backup restore, an update, a wipe) still refuses, as before.
const RESTART_CANCEL_WAIT_MS = 20000;
const RESTART_CANCEL_POLL_MS = 250;
export async function acquireLockForStop(operation, serverId, app) {
  const lock = acquireLifecycleLock(operation, serverId);
  if (lock) return lock;

  // What refuses THIS server: the process-wide lock, or its own hold while
  // a restart of it waits for RCON (holdServerUntilRcon).
  const holder = getLifecycleLockHolder(serverId);
  const wanted = serverId === null || serverId === undefined ? "" : String(serverId).trim();
  const sameServer = !holder?.serverId || !wanted || holder.serverId === wanted;
  if (holder?.operation !== "restart" || !sameServer) return null;

  log.info(`${operation}: a restart is running -- cancelling it`);
  app?.get?.("scheduler")?.cancelRestart?.();

  const deadline = Date.now() + RESTART_CANCEL_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RESTART_CANCEL_POLL_MS));
    const next = acquireLifecycleLock(operation, serverId);
    if (next) return next;
  }
  log.warn(
    `${operation}: the restart did not finish cancelling in ${RESTART_CANCEL_WAIT_MS / 1000} s -- taking over`,
  );
  return supersedeLifecycleLock(operation, serverId);
}

// Stop server (graceful via RCON)
router.post("/stop", requirePermission("server.control"), async (req, res) => {
  // See /start's comment above for why this is fetched before the lock.
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = await acquireLockForStop(
    "stop",
    activeServerForLock?.id ?? null,
    req.app,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  let lifecycleLockTransferred = false;
  let lifecycleLockReleased = false;
  const releaseLifecycleLock = () => {
    if (lifecycleLockReleased) return;
    lifecycleLockReleased = true;
    lifecycleLock.release();
  };
  try {
    const activeServer = activeServerForLock;
    const rconService = req.app.get("rconService");
    const serverManager = req.app.get("serverManager");
    log.info("POST /stop — graceful shutdown requested");

    // Check if RCON is connected first. Both refusals below name the way
    // out: a server whose game thread died (42.21's UnsatisfiedLinkError
    // during a save, 2026-10-01) keeps its process up while RCON keeps
    // dropping, and Force stop is then the only way down -- at the cost of
    // anything since the last successful save, which is why the panel never
    // does it on its own. With RCON disconnected Force stop can't save first
    // (attemptBoundedSaveBeforeForceStop() skips it), so that refusal says
    // so. A remote server has no Force stop (POST /force-stop refuses it,
    // the Dashboard disables the button): its own codes send the operator
    // to the host it runs on instead.
    const isRemote = Boolean(activeServer?.isRemote);
    if (!rconService.connected) {
      return res.status(400).json(
        isRemote
          ? {
              error:
                "RCON is not connected, so the panel can't save the world and stop this remote server. The panel doesn't manage a remote server's process and can't force-stop it: if the server is stuck, restart it on the machine that hosts it.",
              code: ErrorCode.SERVER_STOP_RCON_NOT_CONNECTED_REMOTE,
            }
          : {
              error:
                "RCON is not connected, so the panel can't save the world and stop the server gracefully. If the server is stuck, use Force stop: while RCON is disconnected it can't save first and stops the server straight away, so anything since the last successful save will be lost.",
              code: ErrorCode.SERVER_STOP_RCON_NOT_CONNECTED,
            },
      );
    }

    // Save first — quitting after a failed save discards everything since
    // the last one.
    const saved = await rconService.save({ retryOnConnectionError: false });
    if (!saved?.success) {
      const reason = saved?.error || "unknown error";
      return res.status(502).json(
        isRemote
          ? {
              error: `The world could not be saved (${sanitizeError(reason)}), so the server was left running. The panel doesn't manage a remote server's process and can't force-stop it: if the server is stuck, restart it on the machine that hosts it. Anything since the last successful save can be lost.`,
              code: ErrorCode.SERVER_STOP_SAVE_FAILED_REMOTE,
              params: sanitizeErrorParams({ reason }),
            }
          : {
              error: `The world could not be saved (${sanitizeError(reason)}), so the server was left running. If the server is stuck, use Force stop: it tries one quick save, then stops the server either way, so anything since the last successful save can be lost.`,
              code: ErrorCode.SERVER_STOP_SAVE_FAILED,
              params: sanitizeErrorParams({ reason }),
            },
      );
    }

    // A container-managed server must go down through Docker. RCON quit kills
    // PID 1 inside the container, which exits the container and lets its
    // restart policy bring the world straight back up.
    const managed = await runManagedLifecycle("stop", {
      serverId: activeServer?.id ?? null,
    });
    if (managed.handled && !managed.success) {
      return res.status(502).json({
        error: `The world was saved, but the container could not be stopped: ${sanitizeError(managed.error)}`,
        code: ErrorCode.SERVER_STOP_CONTAINER_STOP_FAILED,
      });
    }

    if (!managed.handled && serverManager.loadConfig) {
      await serverManager.loadConfig(activeServer?.id ?? null);
    }
    const serviceManaged = Boolean(
      !managed.handled && serverManager.usesManagedServiceLifecycle?.(),
    );
    const result = managed.handled
      ? { success: true, message: managed.message || "Container stopping" }
      : serviceManaged
        ? await serverManager.stopServer({
            serverId: activeServer?.id ?? null,
          })
        : await rconService.quit({ retryOnConnectionError: false });

    if (!result?.success || result.confirmed === false) {
      return res.status(502).json({
        ...result,
        success: false,
        error: result?.error || result?.message || "Server stop failed",
      });
    }

    if (managed.handled || serviceManaged) {
      // Docker's own stop API blocks until the container actually stops (or
      // it force-kills after its timeout) before ever returning success --
      // unlike RCON quit() below, "success" here already means confirmed,
      // not just accepted, so this claim (including clearing serverManager's
      // cached run state) is honest as-is.
      serverManager?.markServerStopped?.();
      expireExitedServerHeartbeat();
      const io = req.app.get("io");
      const checkServerStatusNow = req.app.get("checkServerStatusNow");
      if (typeof checkServerStatusNow === "function") {
        Promise.resolve(checkServerStatusNow("managed-stop")).catch((err) =>
          log.debug(`Post-stop status re-check failed: ${err.message}`),
        );
      } else if (io) {
        io.emit("server:status", { running: false });
      }
      await logServerEventBestEffort(
        "server_stop",
        serviceManaged
          ? `Server stopped through ${serverManager.lifecycleProvider}`
          : "Server stopped via web UI",
      );
      req.app
        .get("discordBot")
        ?.sendEventNotification("serverStop", {})
        .catch((err) =>
          log.debug(`Discord serverStop notification failed: ${err.message}`),
        );
    } else {
      // rconService.quit() only proves the RCON command was accepted -- a
      // reset connection is the normal symptom of a real shutdown, but PZ's
      // own save-and-exit can still be running for a while after (longer on
      // a large world). Reporting this as a confirmed stop -- both over the
      // socket and to Schedule/Discord -- is exactly the "confident label
      // over a blind source" shape this floor has been hunting all night:
      // an operator who reads "Stopped" and acts outside the panel (copies
      // the save folder, edits an ini, pulls a Docker volume) may be acting
      // against a process that is still writing.
      //
      // So: this only asserts the request was ACCEPTED. The real
      // confirmation rides the status watchdog (server/index.js) once it
      // genuinely observes the process gone -- nudged here for a faster
      // signal than waiting out its 10s interval, but the interval is what
      // actually guarantees this resolves even if the nudge is lost.
      // checkServerStatusNow is the SOLE place that decides whether the
      // observed state changed and emits server:status for it; calling it
      // here instead of emitting our own claim is what keeps it from ever
      // going stale the way it did before this fix (2026-08-26 bug hunt).
      const checkServerStatusNow = req.app.get("checkServerStatusNow");
      if (typeof checkServerStatusNow === "function") {
        Promise.resolve(checkServerStatusNow("graceful-stop")).catch((err) =>
          log.debug(`Post-stop status re-check failed: ${err.message}`),
        );
      }
      await logServerEventBestEffort(
        "server_stop",
        "Graceful shutdown requested via web UI",
      );
      result.message =
        result.message || result.response || "Shutdown requested";
      result.confirmed = false;
      // A remote server's process is on another host: the monitor's local
      // scan can never see it, so its first poll "confirmed" every remote
      // stop at once and expired the PanelBridge heartbeat while the game
      // could still be saving and writing it (the next write revived it: a
      // second Discord notification and the Stop button back). Had the scan
      // attributed a local PZ process to it instead, the monitor would have
      // force-killed that process after 60s. A remote stop is left to the
      // status watchdog, whose remote verdict is RCON and PanelBridge; the
      // lock is released below, as the panel cannot start, restart or
      // force-stop a remote server anyway.
      if (!activeServer?.isRemote) {
        monitorGracefulStop({
          serverManager,
          releaseLifecycleLock,
          serverId: activeServer?.id ?? null,
          io: req.app.get("io"),
          checkServerStatusNow,
          discordBot: req.app.get("discordBot"),
        });
        lifecycleLockTransferred = true;
      }
    }

    res.json(result);
  } catch (error) {
    log.error(`Failed to stop server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    if (!lifecycleLockTransferred) releaseLifecycleLock();
  }
});

// Force Stop is the escape hatch for when the normal Stop has already
// failed or the server is wedged -- so unlike /stop, /restart and
// docker.js's own action route (which all fail CLOSED: a failed save
// blocks the stop entirely), a failed or slow save here must NEVER block
// the stop, or this stops being an escape hatch and becomes a second way
// to get stuck. But "must never block" doesn't mean "must never try": the
// common case is RCON answers fine and the world gets saved anyway, and
// skipping the attempt outright would throw that away for every operator,
// not just the genuinely wedged one. Bounded to a few seconds -- shorter
// than RconService's own 10s per-command timeout (this.commandTimeout in
// rcon.js), because an operator reaching for Force Stop has already told
// us something is wrong and a slow save is exactly the symptom, not
// something worth waiting out to its normal limit.
const FORCE_STOP_SAVE_TIMEOUT_MS = 3000;
const GRACEFUL_STOP_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

// A graceful stop that never confirms must not just sit there: performRestart()'s
// own stop-phase (this file's restart flow lives in scheduler.js) already
// escalates to a force-kill after 60 failed 1s polls following its RCON quit,
// because "we asked it to stop and nothing ever confirmed it" is a hung panel,
// not a safe wait -- exactly the failure mode the 2026-09-07 hardening request
// named directly ("a graceful shutdown that hangs forever with no escalation
// to a hard kill"). Before this fix, plain POST /stop's monitor only ever
// polled up to GRACEFUL_STOP_CONFIRMATION_TIMEOUT_MS (5 minutes) and then gave
// up silently, releasing the lock with the game process potentially still
// running and nothing having ever tried to actually kill it. This brings
// /stop in line with the SAME bound and the SAME mechanism restart already
// uses (serverManager.stopServer(...)) rather than inventing a new
// escalation path. Only reached for the native-process RCON-quit branch --
// a Docker- or systemd/openrc-managed stop is already confirmed synchronously
// before the route ever calls this (see the `managed.handled || serviceManaged`
// branch above), so there is nothing to escalate there.
const GRACEFUL_STOP_ESCALATE_AFTER_MS = 60 * 1000;

function monitorGracefulStop({
  serverManager,
  releaseLifecycleLock,
  serverId = null,
  io = null,
  checkServerStatusNow = null,
  discordBot = null,
}) {
  if (typeof serverManager?.getServerProcessDetails !== "function") {
    releaseLifecycleLock();
    return;
  }

  const announceStopped = (reason) => {
    if (typeof checkServerStatusNow === "function") {
      Promise.resolve(checkServerStatusNow(reason)).catch((err) =>
        log.debug(`Post-stop status re-check failed: ${err.message}`),
      );
    } else if (io) {
      io.emit("server:status", { running: false });
    }
  };

  const startedAt = Date.now();
  const deadline = startedAt + GRACEFUL_STOP_CONFIRMATION_TIMEOUT_MS;
  let escalated = false;

  const escalateToForceStop = async () => {
    escalated = true;
    log.warn(
      `Graceful stop did not confirm within ${GRACEFUL_STOP_ESCALATE_AFTER_MS / 1000}s; escalating to force-stop`,
    );
    try {
      const forced = await serverManager.stopServer({ serverId });
      if (forced?.success && forced.confirmed !== false) {
        serverManager?.markServerStopped?.();
        expireExitedServerHeartbeat();
        announceStopped("graceful-stop-escalated");
        await logServerEventBestEffort(
          "server_stop",
          "Graceful shutdown did not complete in time; escalated to a force stop",
        );
        discordBot
          ?.sendEventNotification("serverStop", {})
          .catch((err) =>
            log.debug(`Discord serverStop notification failed: ${err.message}`),
          );
      } else {
        // Left running deliberately -- the final poll below still has until
        // GRACEFUL_STOP_CONFIRMATION_TIMEOUT_MS to catch a delayed exit, and
        // the operator's next Force Stop click will report the real reason
        // (this one is just a log trail for what was already tried).
        log.error(
          `Graceful-stop escalation's force-stop did not confirm: ${forced?.error || forced?.message || "unknown error"}`,
        );
      }
    } catch (error) {
      log.error(`Graceful-stop escalation threw: ${error.message}`);
    }
  };

  const poll = async () => {
    try {
      const details = await serverManager.getServerProcessDetails();
      if (details && !details.scanFailed && details.running === false) {
        // Still under the lifecycle lock, so the active server -- whose
        // bridge this is -- cannot have been switched since the stop.
        expireExitedServerHeartbeat();
        releaseLifecycleLock();
        // This poll is the first thing to see the process gone. Without
        // the nudge the stop reached clients only on the watchdog's next
        // 10s tick whenever the one-shot RCON-disconnect re-check (3s after
        // the connection drops) still caught PZ mid-save -- Stop stayed on
        // screen that long after the process had already exited.
        announceStopped("graceful-stop-confirmed");
        return;
      }
    } catch (error) {
      log.debug(`Graceful stop confirmation failed: ${error.message}`);
    }

    const now = Date.now();
    if (!escalated && now - startedAt >= GRACEFUL_STOP_ESCALATE_AFTER_MS) {
      await escalateToForceStop();
      // Check again right away instead of waiting out another full poll
      // tick -- a successful kill confirms in well under a second.
      try {
        const details = await serverManager.getServerProcessDetails();
        if (details && !details.scanFailed && details.running === false) {
          releaseLifecycleLock();
          return;
        }
      } catch (error) {
        log.debug(`Post-escalation confirmation failed: ${error.message}`);
      }
    }

    if (now >= deadline) {
      log.warn("Graceful stop confirmation timed out; releasing lifecycle lock");
      releaseLifecycleLock();
      return;
    }

    const timer = setTimeout(() => {
      void poll();
    }, 1000);
    timer.unref?.();
  };

  void poll();
}

// Attempts a save before a force-stop, bounded and FAIL-OPEN: the caller
// gets `saveOutcome` ("saved" | "failed" | "timedOut" | "skipped") but the
// force-stop itself must proceed regardless of what this returns. Applies
// identically on both the Docker-managed and native branches -- the RCON
// save doesn't care how the process gets killed afterwards, and giving the
// two branches different save behaviour would just be a smaller version of
// the same "one button, two meanings depending on a deployment detail"
// defect this whole fix exists to remove.
async function attemptBoundedSaveBeforeForceStop(rconService) {
  if (!rconService?.connected) return "skipped";
  try {
    const saveResult = await Promise.race([
      rconService.save({ retryOnConnectionError: false }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Force-stop save timed out")),
          FORCE_STOP_SAVE_TIMEOUT_MS,
        ),
      ),
    ]);
    return saveResult?.success ? "saved" : "failed";
  } catch {
    // Either our own timeout above fired, or -- belt and braces, not an
    // expected path -- rconService.save() itself rejected (it shouldn't:
    // execute()'s own try/catch never rethrows). Either way this is the
    // "did not get a confirmed save in time" outcome, not a real failure
    // reason to report separately.
    return "timedOut";
  }
}

// Force stop server
router.post("/force-stop", requirePermission("server.control"), async (req, res) => {
  // See /start's comment above for why this is fetched before the lock.
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = await acquireLockForStop(
    "force-stop",
    activeServerForLock?.id ?? null,
    req.app,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    log.info("POST /force-stop — force kill requested");
    const activeServer = activeServerForLock;
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Cannot force-stop a remote server. The process is not managed by this panel.",
        code: ErrorCode.SERVER_FORCE_STOP_REMOTE_REFUSED,
      });
    }

    const rconService = req.app.get("rconService");
    const saveOutcome = await attemptBoundedSaveBeforeForceStop(rconService);
    log.info(`POST /force-stop — pre-stop save attempt: ${saveOutcome}`);

    // Killing the PID of a containerized server just triggers its restart
    // policy. Docker's stop escalates SIGTERM to SIGKILL on its own and, unlike
    // a process kill, keeps the container down afterwards.
    const managed = await runManagedLifecycle("stop", {
      serverId: activeServer?.id ?? null,
    });
    if (managed.handled && !managed.success) {
      return res
        .status(502)
        .json({ error: sanitizeError(managed.error), saveOutcome });
    }

    const serverManager = req.app.get("serverManager");
    const result = managed.handled
      ? {
          success: true,
          message: managed.message || "Container stopped.",
        }
      : await serverManager.stopServer({
          serverId: activeServer?.id ?? null,
        });

    if (!result?.success || result.confirmed === false) {
      return res.status(502).json({
        ...result,
        success: false,
        error: result?.error || result?.message || "Force stop failed",
        saveOutcome,
      });
    }

    serverManager?.markServerStopped?.();
    expireExitedServerHeartbeat();

    const io = req.app.get("io");
    const checkServerStatusNow = req.app.get("checkServerStatusNow");
    if (typeof checkServerStatusNow === "function") {
      Promise.resolve(checkServerStatusNow("force-stop")).catch((err) =>
        log.debug(`Post-stop status re-check failed: ${err.message}`),
      );
    } else if (io) {
      io.emit("server:status", { running: false });
    }

    res.json({ ...result, saveOutcome });
  } catch (error) {
    log.error(`Failed to force stop server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

// Restart server
router.post("/restart", requirePermission("server.control"), async (req, res) => {
  // See /start's comment above for why this is fetched before the lock.
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "restart",
    activeServerForLock?.id ?? null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  let lifecycleLockTransferred = false;
  try {
    const activeServer = activeServerForLock;
    if (activeServer?.isRemote) {
      return res.status(400).json({
        error:
          "Cannot restart a remote server. The process is not managed by this panel.",
        code: ErrorCode.SERVER_RESTART_REMOTE_REFUSED,
      });
    }

    const scheduler = req.app.get("scheduler");
    if (scheduler.restartInProgress) {
      lifecycleLock.release();
      return res.status(409).json(lifecycleInProgressResponse());
    }
    // Parse and clamp warningMinutes to 0-60 (matches /api/scheduler/restart-now)
    let warningMinutes = parseBoundedInteger(
      req.body?.warningMinutes,
      5,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (warningMinutes > 60) {
      warningMinutes = 60; // Cap at 60 minutes
    }

    // Run restart in background with specified warning time. The HTTP
    // response below only confirms the restart was ACCEPTED -- the
    // countdown + graceful shutdown can take minutes, and performRestart()
    // already computes a real {success, message} on every path. This is a
    // second, independent entry point to the exact same call as scheduler.js's
    // POST /restart-now (Dashboard's Restart/Restart Now buttons hit this
    // route; the Scheduler page's own restart control hits that one) --
    // it had the identical blind-success shape that route used to have
    // before the 2026-08-26 bug hunt fixed it there, just never fixed here.
    const io = req.app.get("io");

    const restartPromise = Promise.resolve(
      scheduler.performRestart(warningMinutes, {
        label: "Manual restart",
        lifecycleLock,
      }),
    );
    lifecycleLockTransferred = true;
    void restartPromise
      .then((result) => {
        emitActionResult(io, {
          kind: "restart",
          success: !!result?.success,
          message: result?.message || (result?.success ? "Restart completed" : "Restart failed"),
          ...(result?.success ? {} : codedActionResultFields(result)),
        });
      })
      .catch((err) => {
        log.error(`Restart failed: ${err.message}`);
        emitActionResult(io, {
          kind: "restart",
          success: false,
          message: err.message,
          ...codedActionResultFields(err),
        });
      })
      .finally(() => lifecycleLock.release());

    res.json({
      success: true,
      message:
        warningMinutes > 0
          ? `Restart initiated with ${warningMinutes} minute warning`
          : "Immediate restart initiated",
    });
  } catch (error) {
    log.error(`Failed to restart server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    if (!lifecycleLockTransferred) lifecycleLock.release();
  }
});

// Save world
router.post("/save", requirePermission("server.control"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.save();
    res.json(result);
  } catch (error) {
    log.error(`Failed to save world: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Message/weather/alarm/removezombies/releasesafehouse below: open to every
// role, deliberately -- these are in-game/GM authority (broadcast a message,
// run a weather or zombie event, release an inactive player's safehouse),
// the same territory as players.js, not server operation.
//
// events/lightning, events/thunder and events/horde are the exception: they
// take an optional username and can strike or spawn a horde AT a named
// player, not just somewhere in the world, so as of 2026-08-27 (operator
// ruling on ranked-bug #5) they are gated on players.endanger_or_impersonate
// instead -- admin-only by default, not open to every role like their
// untargeted siblings above and below.

// Send server message
router.post("/message", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { message } = req.body || {};

    if (!message) {
      return res.status(400).json({ error: "Message is required", code: ErrorCode.SERVER_MESSAGE_REQUIRED });
    }

    if (typeof message !== "string" || message.length > 1000) {
      return res
        .status(400)
        .json({ error: "Message must be a string under 1000 characters", code: ErrorCode.SERVER_MESSAGE_TOO_LONG });
    }

    // Strip newlines/carriage returns to prevent RCON protocol injection
    const safeMessage = message.replace(/[\r\n]/g, " ");

    const result = await rconService.serverMessage(safeMessage);
    res.json(result);
  } catch (error) {
    log.error(`Failed to send message: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Weather controls
router.post("/weather/start-rain", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { intensity } = req.body || {};
    const result = await rconService.startRain(intensity);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/stop-rain", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.stopRain();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/start-storm", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { duration } = req.body || {};
    const result = await rconService.startStorm(duration);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/weather/stop", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.stopWeather();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Events
router.post("/events/chopper", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.triggerChopper();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/gunshot", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.triggerGunshot();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/lightning", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { username } = req.body || {};
    if (username && (typeof username !== "string" || username.length > 64)) {
      return res.status(400).json({ error: "Invalid username", code: ErrorCode.EVENTS_INVALID_USERNAME });
    }
    const result = await rconService.triggerLightning(username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/thunder", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { username } = req.body || {};
    if (username && (typeof username !== "string" || username.length > 64)) {
      return res.status(400).json({ error: "Invalid username", code: ErrorCode.EVENTS_INVALID_USERNAME });
    }
    const result = await rconService.triggerThunder(username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/events/horde", requirePermission("players.endanger_or_impersonate"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { count, username } = req.body || {};
    // Coerced, not refused: the UI's slider already clamps to [10, 500], so
    // an out-of-range value here only reaches this route via a direct API
    // call, and a smaller-than-asked horde is not a "your setting was
    // silently ignored" story the way a swapped port is -- see
    // 2026-08-23 validateInt-coerces audit.
    const safeCount = coerceIntInRange(count, 1, 500, 50);
    if (username && (typeof username !== "string" || username.length > 64)) {
      return res.status(400).json({ error: "Invalid username", code: ErrorCode.EVENTS_INVALID_USERNAME });
    }
    const result = await rconService.createHorde(safeCount, username);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Fallback branches if dynamic fetch fails
// These are the known valid Steam branches for PZ Dedicated Server (App ID 380870)
// `description` here is the client's fallback/default text only -- branch
// picker (client/src/pages/Servers.tsx) resolves it through
// t(`steamDialog.branchDescriptions.${name}`, {defaultValue: description}),
// the same key+defaultValue convention as capabilities.<key>.label. `name`
// is already the stable key, nothing new to add. Branches actually fetched
// from Steam (source: "steam", parseSteamBranches() below) carry Valve's own
// description text -- real dynamic data from a third party, not ours to
// translate, so that path is deliberately left alone.
const FALLBACK_BRANCHES = [
  { name: "public", description: "Current stable release. Recommended for most servers." },
  { name: "unstable", description: "Build 42 testing branch, including multiplayer. Back up saves and expect mod incompatibilities." },
  { name: "iwbums", description: "Experimental testing branch. Back up saves before switching." },
  { name: "legacy41", description: "Legacy Build 41 branch for older worlds and mods." },
];

// 2026-10-20 (access-control audit): detection SAVES what it finds as the
// steamcmdPath setting, so it is a POST and server.install's -- the
// capability that sets steamcmdPath everywhere else (routes/config.js) and
// installs/updates through it. It was a GET under server.world_events, which
// the moderator role holds, and saved only for server.install. Its one
// caller is the Update / Verify dialog (client useSteamBranches), which
// falls back to the typed path when this is refused. SECURITY (2026-10-05,
// H4) still applies: where SteamCMD lives -- usually below the panel
// account's profile, so it names the host account -- goes only to the roles
// that set the server's folders up (utils/hostPathView.js).
router.post("/steamcmd/detect", requirePermission("server.install"), async (req, res) => {
  try {
    const steamcmdPath = await findSteamCmdPath();
    if (!steamcmdPath) {
      return res.json({ found: false, message: "SteamCMD was not found automatically" });
    }

    const configuredPath = await getSetting("steamcmdPath");
    if (configuredPath !== steamcmdPath) {
      await setSetting("steamcmdPath", steamcmdPath);
    }

    if (!(await canSeeHostPaths(req.user))) {
      return res.json({ found: true, message: "SteamCMD found automatically" });
    }

    res.json({
      found: true,
      path: steamcmdPath,
      executable: getSteamCmdExe(steamcmdPath),
      message: "SteamCMD found automatically",
    });
  } catch (error) {
    log.warn(`Failed to detect SteamCMD: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Where another server's folders go outside the all-in-one image: beside
// the active server's install folder. In a container only when that parent
// is on a volume (an unknown answer counts as no), for the same reason as
// the all-in-one serversRoot below.
function hostServersRootFor(servers) {
  const root = suggestHostServersRoot(servers);
  if (!root) return null;
  if (!isWindows && isContainerized() && isOnContainerRootLayer(root) !== false) {
    return null;
  }
  return root;
}

// The names already taken in that root, so the wizard starts on a server
// name whose <name> and <name>_Data are free and warns about a leftover
// data folder: one from a deleted profile would hand the new server the
// old one's settings and world. Capped, and empty when the folder can't be
// read. server.install can list any folder in the folder browser already.
const SERVERS_ROOT_ENTRY_LIMIT = 2000;

async function listServersRootEntries(root) {
  if (!root) return [];
  try {
    return (await fs.promises.readdir(root)).slice(0, SERVERS_ROOT_ENTRY_LIMIT);
  } catch {
    return [];
  }
}

// What the setup wizard needs to create ANOTHER server on this host: the
// ports and data folder every local profile is configured for, the first
// free ports, and where the new server's folders go. In the all-in-one
// image that is the extra-servers volume (allInOne, with the UDP ports
// Docker publishes); elsewhere it is the active install's parent folder
// (hostLayout). Either root is returned only when it really is a volume
// inside a container, so the wizard never suggests a folder the next
// update would erase. serversRootEntries lists what that root already
// holds. environmentDataPath is the PZ_SAVE_PATH rule resolveZomboidPaths()
// applies to an install with no data folder.
router.get("/setup-plan", requirePermission("server.install"), async (req, res) => {
  try {
    const servers = await getServers();
    const usedPorts = collectUsedPorts(servers, {
      defaultDataPath: path.join(os.homedir(), "Zomboid"),
    });
    const layout = getAllInOneLayout();
    const allInOne = layout
      ? {
          serversRoot:
            layout.serversRoot && isOnContainerRootLayer(layout.serversRoot) === false
              ? layout.serversRoot
              : null,
          publishedGamePorts: layout.publishedGamePorts,
        }
      : null;
    const hostLayout = allInOne
      ? null
      : { serversRoot: hostServersRootFor(servers), separator: path.sep };
    res.json({
      usedPorts,
      suggestedPorts: suggestFreePorts(usedPorts, {
        publishedGamePorts: allInOne?.publishedGamePorts ?? null,
      }),
      allInOne,
      hostLayout,
      serversRootEntries: await listServersRootEntries(
        allInOne ? allInOne.serversRoot : hostLayout.serversRoot,
      ),
      environmentDataPath: getEnvironmentDataPath(),
    });
  } catch (error) {
    log.warn(`Failed to build setup plan: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Does this folder hold a SteamCMD binary of its own (steamcmd.exe on Windows,
// steamcmd.sh / steamcmd elsewhere)? Unlike getSteamCmdExe() this ignores the
// system-wide Linux fallbacks, which exist whatever folder was typed.
function steamCmdFolderHasBinary(dir) {
  const names = isWindows ? ["steamcmd.exe"] : ["steamcmd.sh", "steamcmd"];
  return names.some((name) => fs.existsSync(path.join(dir, name)));
}

// Get available Steam branches for PZ Dedicated Server (App ID 380870)
router.get("/branches", requirePermission("server.install"), async (req, res) => {
  try {
    const steamcmdPath =
      req.query.steamcmdPath || (await getSetting("steamcmdPath"));
    log.info(
      `GET /branches (steamcmdPath=${steamcmdPath || "not configured"})`,
    );

    if (!steamcmdPath) {
      // Return fallback branches if no SteamCMD configured
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "SteamCMD path not configured, using fallback branches",
      });
    }

    // Unlike every other route in this file that derives an executable path
    // from user input, this one skipped isValidPath() -- steamcmdPath comes
    // straight off the query string, and getSteamCmdExe() + spawn() below
    // would run whatever binary exists at the caller-chosen path. Validate
    // it the same way /install and /steam-update do before it's ever used.
    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: "Invalid SteamCMD path", code: ErrorCode.STEAMCMD_PATH_INVALID });
    }
    const steamcmdFolderRefused = steamCmdFolderRefusal(steamcmdPath);
    if (steamcmdFolderRefused) return res.status(400).json(steamcmdFolderRefused);

    // A candidate from the query string is saved below, so only one that is
    // really a SteamCMD folder gets that far. The Update dialog asks for the
    // branches as the operator types the path, and each prefix used to be
    // saved as the steamcmdPath setting ("C:\", "C:\Ste", ...) before
    // anything checked it existed. A path that is already the saved setting
    // has nothing new to save, so it keeps the existing lookup below.
    if (
      steamcmdPath !== (await getSetting("steamcmdPath")) &&
      !steamCmdFolderHasBinary(steamcmdPath)
    ) {
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "SteamCMD not found, using fallback branches",
      });
    }

    // Persist a query-string candidate before resolving it into something
    // spawn() runs -- see saveAndResolveSteamCmdExe's header comment
    // (CodeQL js/command-line-injection #11). Browsing/previewing a
    // not-yet-saved path still works exactly as before; it's saved as a
    // side effect of being previewed, rather than trusted straight off the
    // query string for the spawn below.
    const steamcmdExe = await saveAndResolveSteamCmdExe(steamcmdPath);
    if (!steamcmdExe || !fs.existsSync(steamcmdExe)) {
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "SteamCMD not found, using fallback branches",
      });
    }

    // Run SteamCMD to get app info
    const steamcmdArgs = [
      "+login",
      "anonymous",
      "+app_info_update",
      "1",
      "+app_info_print",
      "380870",
      "+quit",
    ];

    const result = await new Promise((resolve, reject) => {
      // timeout-handling-consistency-sweep, 2026-09-10: this used to also
      // carry `timeout: 60000` -- spawn()'s own built-in timeout option --
      // alongside the manual 30-second kill-timer below on the SAME child.
      // The manual one always wins (30000 < 60000), so the spawn option
      // could never actually govern anything; it was dead code that could
      // mislead a future editor into thinking raising "the" timeout here
      // (this one) would change behavior when only the 30-second timer
      // below does. Deleted rather than reconciled to one value, since the
      // manual timer already does everything needed (kills the process,
      // rejects with a clear message) and duplicating that via spawn's own
      // option would just be two mechanisms for the same thing again.
      const branchSpawnOpts = { cwd: steamcmdPath };
      if (!isWindows) {
        branchSpawnOpts.env = buildLinuxSteamCmdEnv(steamcmdPath);
      }
      const steamcmd = spawn(steamcmdExe, steamcmdArgs, branchSpawnOpts);

      let stdout = "";
      let stderr = "";
      let completed = false;

      // Timeout after 30 seconds
      const timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          steamcmd.kill();
          reject(new Error("SteamCMD timed out"));
        }
      }, 30000);

      steamcmd.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      steamcmd.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      steamcmd.on("close", (code) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          resolve({ code, stdout, stderr });
        }
      });

      steamcmd.on("error", (err) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    });

    // Parse the output to find branches
    const branches = parseSteamBranches(result.stdout);

    if (branches.length === 0) {
      return res.json({
        branches: FALLBACK_BRANCHES,
        source: "fallback",
        message: "Could not parse branches from SteamCMD output",
      });
    }

    res.json({
      branches,
      source: "steam",
      message: "Branches fetched from Steam",
    });
  } catch (error) {
    log.warn(`Failed to fetch Steam branches: ${error.message}`);
    res.json({
      branches: FALLBACK_BRANCHES,
      source: "fallback",
      message: `Error: ${sanitizeError(error.message)}`,
    });
  }
});

// Parse Steam app_info output to extract branches
function parseSteamBranches(output) {
  const branches = [];

  try {
    // Look for the "branches" section in VDF format
    // Format is like:
    // "branches"
    // {
    //   "public"
    //   {
    //     "buildid" "12345"
    //     "timeupdated" "1234567890"
    //   }
    //   "unstable"
    //   {
    //     "buildid" "12346"
    //     "description" "Build 42"
    //     ...
    //   }
    // }

    const branchesMatch = output.match(/"branches"\s*\{([^]*?)\n\t\t\}/);
    const altMatch = !branchesMatch
      ? output.match(/"branches"\s*\{([^]*?)\}\s*"installedrepots"/i)
      : null;

    if (!branchesMatch && !altMatch) {
      return branches;
    }

    const branchesSection = (branchesMatch || altMatch)[1];

    // Extract individual branch names and their properties
    // Match pattern: "branchname" followed by { ... }
    const branchRegex = /^\s*"([^"]+)"\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gm;
    let match;

    while ((match = branchRegex.exec(branchesSection)) !== null) {
      const branchName = match[1];
      const branchContent = match[2];

      // Skip password-protected branches
      if (
        branchContent.includes('"pwdrequired"') &&
        branchContent.includes('"1"')
      ) {
        continue;
      }

      // Extract description if available
      const descMatch = branchContent.match(/"description"\s+"([^"]+)"/);
      const description = descMatch
        ? descMatch[1]
        : branchName === "public"
          ? "Default stable branch"
          : "";

      // Extract buildid for reference
      const buildMatch = branchContent.match(/"buildid"\s+"(\d+)"/);
      const buildId = buildMatch ? buildMatch[1] : null;

      // Extract time updated
      const timeMatch = branchContent.match(/"timeupdated"\s+"(\d+)"/);
      const timeUpdated = timeMatch
        ? new Date(parseInt(timeMatch[1], 10) * 1000).toISOString()
        : null;

      branches.push({
        name: branchName,
        description: description || branchName,
        buildId,
        timeUpdated,
      });
    }

    // Sort: public first, then alphabetically
    branches.sort((a, b) => {
      if (a.name === "public") return -1;
      if (b.name === "public") return 1;
      return a.name.localeCompare(b.name);
    });
  } catch (err) {
    log.warn(`Failed to parse Steam branches: ${err.message}`);
  }

  return branches;
}

// Helper to build Steam beta arguments as array. Stable is asked for by
// name too: with no -beta, SteamCMD keeps whatever branch the install's
// appmanifest last asked for (its UserConfig BetaKey), so a folder that was
// ever on "42.19" or "unstable" stayed there when Stable was picked. Since
// Build 42 went stable, Steam keeps a "42.19" branch for servers that want
// to stay on it, and operators reported getting 42.19 from Stable.
export function getBetaArgs(branch) {
  // Backwards compatibility: treat boolean true as 'unstable'
  if (branch === true) return ["-beta", "unstable"];
  // Allow any branch name - Steam will validate it
  return ["-beta", normalizeSteamBranch(branch)];
}

export async function getSteamLoginArgs() {
  const account = String((await getSetting("steamUpdateAccount")) || "").trim();
  if (account) {
    log.warn(
      "Ignoring steamUpdateAccount for SteamCMD updates: the panel cannot complete an interactive password or Steam Guard prompt",
    );
  }
  return ["+login", "anonymous"];
}

// SteamCMD Installation endpoint
router.post("/install", requirePermission("server.install"), async (req, res) => {
  let activeOperationPath = null;
  try {
    const {
      steamcmdPath: suppliedSteamcmdPath,
      installPath,
      serverName: suppliedServerName,
      branch,
      useUnstable, // Legacy support
      // New options
      zomboidDataPath,
      minMemory = 4,
      maxMemory = 8,
      adminPassword,
      serverPort = 16261,
      useUpnp = true,
      useNoSteam = false,
      useDebug = false,
      // RCON settings
      rconPassword,
      rconPort = 27015,
    } = req.body;

    // Refused, not stripped to fit the .ini: see utils/rconPassword.js.
    if (rconPasswordCannotBeStoredInIni(rconPassword)) {
      return res.status(400).json(rconPasswordUnsupportedCharsBody());
    }

    // Trimmed once, here: isValidServerName() judges the trimmed text, so the
    // untrimmed " MyServer " it accepted used to name the .ini "MyServer .ini"
    // and the start scripts StartServer_ MyServer .bat.
    const serverName = trimmedServerName(suppliedServerName);

    // steamcmd-install-detect-fallback, 2026-09-09: an explicitly supplied
    // steamcmdPath always wins; only fall back to findSteamCmdPath() (the
    // same detection POST /steamcmd/detect already runs and persists) when
    // the field is absent. In our own all-in-one image the answer is
    // deterministic (STEAMCMD_FIXED_CANDIDATE_PATHS[0]), so 400ing before
    // even trying to detect was asking the operator for something we
    // already knew.
    const steamcmdPath = suppliedSteamcmdPath || (await findSteamCmdPath());

    // Determine branch - support both new 'branch' param and legacy 'useUnstable'
    const selectedBranch = branch || (useUnstable ? "unstable" : "stable");
    log.info(
      `POST /install (steamcmd=${steamcmdPath}, install=${installPath}, server=${serverName}, branch=${selectedBranch}, noSteam=${useNoSteam}, debug=${useDebug})`,
    );

    // Validate paths - Security check for path traversal
    if (!steamcmdPath || !installPath || !serverName) {
      const missing = [];
      if (!steamcmdPath) missing.push("steamcmdPath");
      if (!installPath) missing.push("installPath");
      if (!serverName) missing.push("serverName");
      // Tell the operator where we looked, not just that detection failed
      // -- a dead end costs them a support ticket, one sentence doesn't.
      const steamcmdNotFoundHint = !steamcmdPath
        ? ` SteamCMD was not found automatically either -- checked ${STEAMCMD_FIXED_CANDIDATE_PATHS.join(", ")}.`
        : "";
      return res.status(400).json({
        error: `Missing required fields: ${missing.join(", ")}.${steamcmdNotFoundHint}`,
        code: ErrorCode.INSTALL_MISSING_FIELDS,
      });
    }

    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: "Invalid SteamCMD path", code: ErrorCode.STEAMCMD_PATH_INVALID });
    }
    const steamcmdFolderRefused = steamCmdFolderRefusal(steamcmdPath);
    if (steamcmdFolderRefused) return res.status(400).json(steamcmdFolderRefused);

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid install path", code: ErrorCode.INSTALL_PATH_INVALID });
    }

    if (!isValidServerName(serverName)) {
      return res.status(400).json({
        error:
          "Invalid server name. Use only letters, numbers, underscores, hyphens, and spaces (max 64 chars)",
        code: ErrorCode.SERVER_NAME_FORMAT_INVALID,
      });
    }

    if (zomboidDataPath && !isValidPath(zomboidDataPath)) {
      return res.status(400).json({ error: "Invalid Zomboid data path", code: ErrorCode.ZOMBOID_DATA_PATH_INVALID });
    }

    const adminPasswordRefusal = adminPasswordStartScriptRefusal(adminPassword);
    if (adminPasswordRefusal) {
      return res.status(400).json(adminPasswordRefusal);
    }

    const { zomboidPath, serverConfigPath, usesEnvironmentDataPath } =
      resolveZomboidPaths(installPath, zomboidDataPath);

    // SECURITY (2026-10-05, PATHS-1): the data folder this install saves
    // (the one sent, or the <install>_Data default beside a caller-chosen
    // install folder) is held to the rule every data-folder setter shares
    // (services/zomboidDataPath.js) before anything is downloaded or written
    // into it. As sent, no %VAR% expansion: this route uses it that way.
    // PZ_SAVE_PATH's folder is the operator's own.
    if (!usesEnvironmentDataPath) {
      const dataPathCheck = checkZomboidDataPath(zomboidPath, { expand: false });
      if (!dataPathCheck.ok) {
        return res.status(400).json(dataPathCheck.body);
      }
    }

    // steamcmd-routes-running-check, 2026-09-08: installPath can point at an
    // EXISTING install with a server already running there (a re-run, a
    // repair, or simply the wrong path) -- SteamCMD writing over live game
    // files, and this route's own later writeFileAtomic() calls rewriting a
    // running JVM's INI/start scripts out from under it, is exactly the
    // "wholesale overwrite while running" class serverFiles.js's own
    // requireStoppedForLocalConfigMutation exists to block, except this
    // route had no guard at all. See resolveTargetServerForRunningCheck's
    // own comment for why Convention A (the shared serverManager singleton)
    // would answer the wrong question here.
    // Every profile using this game folder, not only the first one found.
    const { target: installTargetServer, sharing: installSharingServers } =
      await resolveTargetServerForRunningCheck(installPath, { serverName, zomboidDataPath });
    const installNotStoppedError = await checkGameFolderServersStopped(
      installTargetServer,
      installSharingServers,
      "installing to this path",
    );
    if (installNotStoppedError) {
      return res
        .status(installNotStoppedError.status)
        .json(installNotStoppedError.body);
    }

    // steamcmd-ops-never-check-the-lifecycle-lock, 2026-09-09: this route
    // never checked lifecycleCoordinator's global lock at all, so it could
    // start while wipe/restore/template-apply already held it FOR THIS SAME
    // SERVER. Not a global block (SteamCMD must not take the lock itself --
    // see lifecycleCoordinator.js's own comment on isLifecycleLockedForServer
    // for why) -- refuses only when the held lock names installTargetServer's
    // own id (or another profile using the same folder), same as every other
    // lock-aware refusal in this file.
    if (
      isLifecycleLockedForServer(installTargetServer.id) ||
      installSharingServers.some((server) => isLifecycleLockedForServer(server.id))
    ) {
      return res.status(409).json(lifecycleInProgressResponse());
    }

    // The game folder decides the PanelBridge delivery: a folder another
    // profile gets PanelBridge for from the Steam Workshop can't take a
    // profile (or launch scripts) that start without Steam.
    if (useNoSteam === true && newProfileConflictsWithWorkshop({ installPath, useNoSteam }, await getServers())) {
      return res.status(409).json(noSteamWorkshopConflictResponse());
    }

    // Before ensureWritableDirectory() below creates anything: a container
    // folder that isn't on a volume is lost on the next recreate.
    for (const directoryPath of [installPath, zomboidPath]) {
      const ephemeralError = formatEphemeralContainerPathError(directoryPath);
      if (ephemeralError) {
        return res.status(400).json({
          error: ephemeralError.message,
          code: ephemeralError.code,
          params: ephemeralError.params,
        });
      }
    }

    try {
      ensureWritableDirectory(installPath);
    } catch (directoryError) {
      const writableError = formatWritablePathError("install", installPath);
      return res.status(400).json({
        error: writableError.message,
        code: writableError.code,
        params: writableError.params,
      });
    }

    try {
      ensureWritableDirectory(serverConfigPath);
    } catch (directoryError) {
      const writableError = formatWritablePathError("data", zomboidPath);
      return res.status(400).json({
        error: writableError.message,
        code: writableError.code,
        params: writableError.params,
      });
    }

    // Validate numeric inputs -- each of these was explicitly typed into a
    // field by the operator, so an out-of-range value is refused (with a
    // named field + range) rather than silently swapped for a default they
    // never chose. See 2026-08-23 validateInt-coerces audit.
    const minMemoryCheck = requireIntInRange(minMemory, MEMORY_GB_MIN, MIN_MEMORY_GB_MAX, "Minimum memory (GB)");
    if (!minMemoryCheck.ok) {
      return res.status(400).json({ error: minMemoryCheck.message, code: ErrorCode.INVALID_MIN_MEMORY });
    }
    const maxMemoryCheck = requireIntInRange(maxMemory, MEMORY_GB_MIN, MAX_MEMORY_GB_MAX, "Maximum memory (GB)");
    if (!maxMemoryCheck.ok) {
      return res.status(400).json({ error: maxMemoryCheck.message, code: ErrorCode.INVALID_MAX_MEMORY });
    }
    const serverPortCheck = requireIntInRange(serverPort, BIND_PORT_MIN, GAME_PORT_MAX, "Game port");
    if (!serverPortCheck.ok) {
      return res.status(400).json({ error: serverPortCheck.message, code: ErrorCode.INVALID_SERVER_PORT });
    }
    const rconPortCheck = requireIntInRange(rconPort, BIND_PORT_MIN, BIND_PORT_MAX, "RCON port");
    if (!rconPortCheck.ok) {
      return res.status(400).json({ error: rconPortCheck.message, code: ErrorCode.INVALID_RCON_PORT });
    }
    const safeMinMemory = minMemoryCheck.value;
    const safeMaxMemory = maxMemoryCheck.value;
    const safeServerPort = serverPortCheck.value;
    const safeRconPort = rconPortCheck.value;

    // Check if steamcmd exists — auto-download it instead of hard-failing
    // on either platform (see ensureSteamCmdInstalled for why: fresh
    // volumes, or a previous install that never finished, shouldn't force a
    // manual re-run of the setup wizard -- windows-steamcmd-selfheal,
    // 2026-09-10, closed the Windows-only gap this comment used to describe
    // as a Linux-only capability).
    // Persist steamcmdPath as the configured setting before resolving an
    // executable from it -- see saveAndResolveSteamCmdExe's header comment
    // (CodeQL js/command-line-injection #12).
    let steamcmdExe = await saveAndResolveSteamCmdExe(steamcmdPath);
    const needsSteamCmdSelfHeal = !steamcmdExe || !fs.existsSync(steamcmdExe);

    // Prevent concurrent operations on the same install path -- checked (and
    // claimed, below) before self-heal now instead of after it, so a second
    // request for the SAME path is refused immediately instead of only after
    // self-heal has already run in the background for the first one.
    const normalizedPath = path.normalize(installPath).toLowerCase();
    if (hasActiveSteamOperation(normalizedPath)) {
      return res.status(409).json({
        error:
          "A Steam operation is already in progress for this path. Please wait for it to complete.",
        code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_PATH,
      });
    }

    // install-selfheal-background, 2026-09-18: steamcmdDownloadInProgress is
    // the single-flight guard ensureSteamCmdInstalled() itself claims
    // synchronously (see its own comment) -- checked here too so a request
    // that would only discover the conflict once self-heal starts in the
    // background below still gets the same immediate 409 it always has,
    // instead of a misleading "Installation started" followed by a failure.
    if (needsSteamCmdSelfHeal && steamcmdDownloadInProgress) {
      return res.status(409).json({
        error: "A SteamCMD download is already in progress",
        code: ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS,
      });
    }

    log.info(
      `Starting PZ server installation to ${installPath} (branch: ${selectedBranch})`,
    );

    // Mark operation as active
    activeSteamOperations.set(normalizedPath, {
      type: "install",
      startTime: Date.now(),
      lastOutputAt: Date.now(),
      branch: selectedBranch,
      serverName,
    });
    activeOperationPath = normalizedPath;

    // Reinstalling into a folder that still holds a game install: the same
    // manifest recovery POST /steam-update runs, once this request owns the
    // path (a branch mounted from an earlier install, or a manifest stuck in
    // the access-denied state, otherwise survives the reinstall).
    try {
      const recovery = recoverMismatchedSteamBranchManifest(installPath, selectedBranch);
      if (recovery) {
        log.warn(
          `Reset stale SteamCMD branch manifest (${recovery.mountedBranch} -> ${recovery.targetBranch}); backup: ${recovery.backupPath}`,
        );
      }
      const blocked = recoverBlockedSteamManifest(installPath);
      if (blocked) {
        log.warn(`Reset SteamCMD manifest stuck in access-denied state 0x6; backup: ${blocked.backupPath}`);
      }
    } catch (error) {
      log.warn(`Could not inspect SteamCMD branch manifest: ${error.message}`);
    }

    const io = req.app.get("io");

    // install-events-cross-install-contamination, 2026-09-18: this route's
    // concurrency guard is scoped per installPath (see hasActiveSteamOperation
    // above), so two operators (or one operator running two setup wizards)
    // CAN legitimately install two different new servers at the same time --
    // the exact shape steam-update-events-cross-server-contamination already
    // found and fixed for /steam-update's steam:start/steam:log/steam:complete.
    // install:log/install:complete had the identical gap: every connected
    // client received every event with no identifier at all, so a second
    // wizard's log lines interleaved into the first one's panel, and its
    // install:complete could resolve the WRONG wizard as success/failure
    // (registering/activating the wrong server, or reporting a still-running
    // install as failed). Same fix, same shape: installPath (the exact string
    // this request received) rides on every emit so the client can filter to
    // only the operation its own wizard started.
    const installEventScope = { installPath };

    // install-selfheal-background, 2026-09-18 (should-steamcmd-self-heal-
    // hold-the-http-response-or-run-in-background): ensureSteamCmdInstalled's
    // own download+extract+first-run can take minutes -- awaiting it here,
    // before responding (as this route used to), held this HTTP response
    // open the whole time, well past the client's own default request
    // timeout (client/src/lib/api.ts's fetchTimeout is 15s for this call),
    // so a self-heal that was still genuinely running server-side showed up
    // to the operator as "Installation failed" while the panel kept working
    // underneath. Respond now -- the same "the request only confirms this
    // was launched, the real outcome arrives over the socket" contract the
    // real SteamCMD spawn below (and POST /steam-update) already use --
    // and run self-heal + the real install in the background. Every
    // failure branch from here on emits its own install:complete (scoped by
    // installEventScope, same as every other failure branch below) instead
    // of an HTTP error, since the response is already sent; the client's
    // handleInstallComplete already treats that identically to the old
    // HTTP-error catch path (see its own comment).
    res.json({
      success: true,
      message: "Installation started. Check the log for progress.",
      installPath,
      branch: selectedBranch,
    });

    (async () => {
      try {
        if (needsSteamCmdSelfHeal) {
          steamcmdExe = await ensureSteamCmdInstalled(steamcmdPath, io);
        }

        // Build SteamCMD command
        // App ID 380870 is Project Zomboid Dedicated Server
        const betaArgs = getBetaArgs(selectedBranch);
        const loginArgs = await getSteamLoginArgs();
        const steamcmdArgs = [
          "+force_install_dir",
          installPath,
          ...loginArgs,
          // Fresh app info first: otherwise SteamCMD installs the build its
          // cached app info names for the branch, which can be weeks old.
          "+app_info_update",
          "1",
          "+app_update",
          "380870",
          ...betaArgs,
          "validate",
          "+quit",
        ];

        // Spawn SteamCMD process
        const spawnOpts = { cwd: steamcmdPath };
        if (!isWindows) {
          spawnOpts.env = buildLinuxSteamCmdEnv(steamcmdPath);
        }
        const steamcmd = spawn(steamcmdExe, steamcmdArgs, spawnOpts);
        // A signal-killed process reports code=null to the close handler below,
        // not the exit code INSTALL_FAILED_EXIT_CODE's message names -- tracked
        // so that branch can say "stalled and was stopped" instead of the
        // literal word "null" (2026-08-26 install-failure hunt finding #1).
        let killedByWatchdog = false;
        activeSteamOperations.get(normalizedPath).watchdog = setInterval(() => {
          const activeOperation = activeSteamOperations.get(normalizedPath);
          if (!activeOperation) return;
          if (!isSteamOperationIdle(activeOperation)) return;

          log.error(
            `SteamCMD ${activeOperation.type} produced no output for ${STEAM_OPERATION_IDLE_TIMEOUT_MS / 60000} minutes; terminating the stalled process`,
          );
          killedByWatchdog = true;
          steamcmd.kill();
        }, 30_000);
        activeSteamOperations.get(normalizedPath).watchdog.unref?.();

        let output = "";
        let stdoutBuffer = "";
        let stderrBuffer = "";

        steamcmd.stdout.on("data", (data) => {
          const operation = activeSteamOperations.get(normalizedPath);
          if (operation) operation.lastOutputAt = Date.now();
          const text = data.toString();
          output += text;
          stdoutBuffer += text;

          // Split by newlines and emit each line for real-time streaming
          const lines = stdoutBuffer.split(/\r?\n/);
          // Keep the last incomplete line in the buffer
          stdoutBuffer = lines.pop() || "";

          for (const line of lines) {
            if (line.trim()) {
              emitRawSteamCmdLine(io, "install:log", "stdout", line, installEventScope);
              log.info(`SteamCMD: ${line}`);
            }
          }
        });

        steamcmd.stderr.on("data", (data) => {
          const operation = activeSteamOperations.get(normalizedPath);
          if (operation) operation.lastOutputAt = Date.now();
          const text = data.toString();
          output += text;
          stderrBuffer += text;

          // Split by newlines and emit each line for real-time streaming
          const lines = stderrBuffer.split(/\r?\n/);
          // Keep the last incomplete line in the buffer
          stderrBuffer = lines.pop() || "";

          for (const line of lines) {
            if (line.trim()) {
              emitRawSteamCmdLine(io, "install:log", "stderr", line, installEventScope);
              log.warn(`SteamCMD stderr: ${line}`);
            }
          }
        });

        steamcmd.on("close", async (code) => {
          // Flush any remaining buffered output
          if (stdoutBuffer.trim()) {
            emitRawSteamCmdLine(io, "install:log", "stdout", stdoutBuffer.trim(), installEventScope);
            log.info(`SteamCMD: ${stdoutBuffer.trim()}`);
          }
          if (stderrBuffer.trim()) {
            emitRawSteamCmdLine(io, "install:log", "stderr", stderrBuffer.trim(), installEventScope);
            log.warn(`SteamCMD stderr: ${stderrBuffer.trim()}`);
          }

          // continuous-bug-hunt, 2026-09-18 (install-wizard-hunt): SteamCMD is
          // well documented to exit 0 even when +app_update failed partway -- a
          // disk-full write failure, a rejected/incomplete download, or a
          // config-resolution failure all print one or more "ERROR!"-prefixed
          // lines (or, for the config case, "Missing configuration") and then
          // still exit 0. Exactly the same gap /steam-update's own
          // steamcmd-success-truth fix closed for update/verify (see that
          // route's steamCmdReportedError, same regex) -- it never transferred
          // here. hasPzInstallMarker() below only proves SOME marker file
          // exists; on a disk-full download those small launcher/metadata files
          // can already be on disk before the write failure hits the large game
          // data, so a marker being present does not contradict SteamCMD having
          // just reported ERROR! in the same run. Checked before hasPzInstallMarker,
          // not as a replacement for it -- either signal alone can miss a partial
          // install; both together catch more than either would.
          const steamCmdReportedError =
            /^\s*ERROR!/im.test(output) || /missing configuration/i.test(output);

          if (code === 0 && steamCmdReportedError) {
            log.error(
              "SteamCMD exited cleanly (code 0) but reported an error in its own output during the install",
            );
            io.to("install").emit("install:complete", {
              success: false,
              message:
                "SteamCMD exited cleanly (code 0) but reported an error in its own output -- check the SteamCMD log above for the exact line. This can happen when the disk fills up mid-download or a Steam-side error interrupts it partway; the install did not complete. Free up space or retry, then reinstall.",
              output,
              progressCode: ProgressCode.INSTALL_STEAMCMD_REPORTED_ERROR,
              ...installEventScope,
            });
          } else if (code === 0) {
            log.info("PZ server installation completed successfully");
            warnIfMountedSteamBranchDiffers(installPath, selectedBranch, "install");

            // The game files installed -- that part is done and expensive to
            // redo, so success:false is never used for a failure past this
            // point (2026-08-26 install-failure hunt finding #6). A step below
            // that fails but self-heals on the next POST /server/start (the INI
            // pre-create, the startup script) is instead collected here and
            // sent as a `warnings` array alongside success:true, so the
            // operator sees it without being told to reinstall over it.
            const warnings = [];

            // Auto-update settings with new paths. Wrapped: these were bare
            // awaits with nothing catching a throw, and this app's
            // unhandledRejection handler (server/index.js) kills the whole
            // panel process on an uncaught rejection -- so a transient
            // settings-write failure here used to take the panel down mid-
            // install instead of just leaving a setting unsaved. The game
            // files already installed successfully at this point, so this
            // follows the same warnings-array convention as the other
            // self-healing failures below rather than reporting success:false.
            try {
              await setSetting("serverPath", installPath);
              await setSetting("serverName", serverName);
              await setSetting("minMemory", minMemory);
              await setSetting("maxMemory", maxMemory);
              await setSetting("serverPort", serverPort);
              await setSetting("useUpnp", useUpnp);

              // zomboidPath is the folder as the game gets it (resolved, no
              // trailing separator); the same text goes into the start script
              // and the profile.
              await setSetting("zomboidDataPath", zomboidPath);
              if (!zomboidDataPath) {
                io.to("install").emit("install:log", {
                  type: "stdout",
                  text: `Using ${usesEnvironmentDataPath ? "configured" : "isolated"} data folder: ${zomboidPath}`,
                  progressCode: usesEnvironmentDataPath
                    ? ProgressCode.DATA_FOLDER_USING_CONFIGURED
                    : ProgressCode.DATA_FOLDER_USING_ISOLATED,
                  params: { path: zomboidPath },
                  ...installEventScope,
                });
              }

              await setSetting("serverConfigPath", serverConfigPath);
            } catch (settingsError) {
              log.error(`Failed to save install settings: ${settingsError.message}`);
              warnings.push({
                progressCode: ProgressCode.INSTALL_SETTINGS_SAVE_FAILED,
                message: `Server files installed, but some install settings could not be saved (${sanitizeError(settingsError.message)}). Re-check them under Settings once the panel is back up.`,
                params: { fields: "serverPath, serverName, memory, port, UPnP, data paths", reason: sanitizeError(settingsError.message) },
              });
            }

            // Re-check after the download in case a mounted path changed while
            // SteamCMD was running.
            try {
              ensureWritableDirectory(serverConfigPath);
            } catch (dirError) {
              // Keep the raw errno in the log even though the operator-facing
              // text below is friendlier -- someone debugging still needs it.
              log.error(
                `Data folder is not writable: ${zomboidPath} (${dirError.message})`,
              );
              // Reuses formatWritablePathError -- the SAME container-aware
              // guidance the pre-download check above already gives, instead of
              // this "re-check after the download" duplicate growing its own,
              // Linux-only message that never checked isContainer (found
              // 2026-08-29, "raw EACCES with no pointer to the fix" hunt: it
              // told a Docker operator to run a command inside the ephemeral
              // container that can't fix a host-side bind-mount ownership
              // mismatch at all). The concrete `sudo install -d` example is
              // still worth keeping for bare metal specifically -- more
              // actionable than the shared message's generic chown/chmod
              // pointer -- so it rides along as an extra param rather than
              // being lost.
              const writableError = formatWritablePathError("data", zomboidPath);
              const bareMetalCommand =
                writableError.code === ErrorCode.WRITABLE_PATH_DATA_BAREMETAL
                  ? `sudo install -d -m 0755 -o "$(whoami)" -g "$(whoami)" "${zomboidPath}"`
                  : null;
              io.to("install").emit("install:complete", {
                success: false,
                message: bareMetalCommand
                  ? `${writableError.message} For example: ${bareMetalCommand}`
                  : writableError.message,
                installPath,
                serverName,
                progressCode: writableError.code,
                params: {
                  ...writableError.params,
                  reason: dirError.code || dirError.message,
                  ...(bareMetalCommand ? { command: bareMetalCommand } : {}),
                },
                ...installEventScope,
              });
              clearActiveSteamOperation(normalizedPath);
              return;
            }

            // Save RCON settings for later use. Same crash exposure and same
            // fix as the settings block above -- a bare await here previously
            // meant a failed RCON settings write could take the whole panel
            // down instead of just leaving RCON unconfigured.
            if (rconPassword) {
              try {
                await setSetting("rconPassword", rconPassword);
                await setSetting("rconPort", rconPort);
                await setSetting("rconHost", resolveEnvRconHost());
                io.to("install").emit("install:log", {
                  type: "stdout",
                  text: `RCON settings saved (port: ${rconPort})`,
                  progressCode: ProgressCode.RCON_SETTINGS_SAVED,
                  params: { port: rconPort },
                  ...installEventScope,
                });
              } catch (rconSettingsError) {
                log.error(`Failed to save RCON settings: ${rconSettingsError.message}`);
                warnings.push({
                  progressCode: ProgressCode.INSTALL_SETTINGS_SAVE_FAILED,
                  message: `Server files installed, but the RCON password/port could not be saved (${sanitizeError(rconSettingsError.message)}). Re-check them under Settings once the panel is back up.`,
                  params: { fields: "RCON password, port, host", reason: sanitizeError(rconSettingsError.message) },
                });
              }
            }

            // Pre-create the INI with RCON + UPnP settings so PZ reads them on
            // first boot (PZ reads the INI at startup -- if we wait until
            // after, they won't take effect). Previously this whole block only
            // ran `if (rconPassword)`, which meant a server installed without
            // an RCON password never got its UPnP choice written either, even
            // though the two have nothing to do with each other -- the
            // wizard's UPnP checkbox saved a global legacy setting nothing
            // ever read, and never touched this server's own .ini at all
            // (2026-08-26, same-night audit alongside the adminPassword fix:
            // "wire it, don't remove it"). Decoupled from rconPassword so a
            // server's UPnP choice reaches its .ini regardless.
            try {
              const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
              if (!fs.existsSync(iniPath)) {
                if (!fs.existsSync(serverConfigPath)) {
                  fs.mkdirSync(serverConfigPath, { recursive: true });
                }
                const lines = [
                  "# Auto-generated by Zomboid Control Panel",
                  "# PZ will add remaining default settings on first server start",
                  `UPnP=${useUpnp ? "true" : "false"}`,
                ];
                if (rconPassword) {
                  lines.push(`RCONPort=${safeRconPort}`, `RCONPassword=${rconPassword}`);
                }
                writeFileAtomic(iniPath, lines.join("\n") + "\n", {
                  encoding: "utf-8",
                  mode: 0o600,
                });
                log.info(
                  `Pre-created INI at ${iniPath} (UPnP=${useUpnp}${rconPassword ? ", RCON configured" : ""})`,
                );
                io.to("install").emit("install:log", rconPassword
                  ? {
                      type: "stdout",
                      text: "Pre-created server INI with RCON credentials",
                      progressCode: ProgressCode.INI_PRECREATED_WITH_RCON,
                      ...installEventScope,
                    }
                  : {
                      type: "stdout",
                      text: "Pre-created server INI with UPnP setting",
                      progressCode: ProgressCode.INI_PRECREATED_WITH_UPNP,
                      ...installEventScope,
                    });
              }
            } catch (iniError) {
              log.warn(`Failed to pre-create INI: ${iniError.message}`);
              const permissionHint =
                iniError.code === "EACCES"
                  ? ` ${formatWritablePathError("data", serverConfigPath).message}`
                  : "";
              warnings.push({
                progressCode: ProgressCode.INSTALL_RCON_INI_PRECREATE_FAILED,
                message: `Could not pre-write ${rconPassword ? "the RCON password" : "the UPnP setting"} into the server config (${sanitizeError(iniError.message)}).${permissionHint} This is retried automatically the next time you start the server.`,
                params: { reason: sanitizeError(iniError.message) },
              });
            }

            // Generate custom startup scripts (both .bat and .sh)
            try {
              const scripts = generateStartupScripts({
                installPath,
                serverName,
                minMemory: safeMinMemory,
                maxMemory: safeMaxMemory,
                zomboidDataPath: zomboidPath,
                adminPassword,
                serverPort: safeServerPort,
                useNoSteam,
                useDebug,
              });

              const batchPath = path.join(
                installPath,
                `StartServer_${serverName}.bat`,
              );
              writeFileAtomic(batchPath, scripts.bat, {
                encoding: "utf8",
                // security audit L1: the .bat embeds -adminpassword; keep it
                // owner-only like the .sh (0750) instead of the umask default.
                mode: 0o600,
              });
              log.info(`Created custom startup batch: ${batchPath}`);

              const shellPath = path.join(
                installPath,
                `start-server_${serverName}.sh`,
              );
              writeFileAtomic(shellPath, scripts.sh.replace(/\r\n/g, "\n"), {
                encoding: "utf8",
                mode: 0o750,
              });
              log.info(`Created custom startup script: ${shellPath}`);

              const scriptName =
                process.platform === "win32"
                  ? `StartServer_${serverName}.bat`
                  : `start-server_${serverName}.sh`;
              io.to("install").emit("install:log", {
                type: "stdout",
                text: `Created custom startup script: ${scriptName}`,
                progressCode: ProgressCode.STARTUP_SCRIPT_CREATED,
                params: { scriptName },
                ...installEventScope,
              });
            } catch (batchError) {
              log.warn(`Failed to create startup scripts: ${batchError.message}`);
              warnings.push({
                progressCode: ProgressCode.INSTALL_STARTUP_SCRIPT_FAILED,
                message: `Could not generate this server's custom startup script (${sanitizeError(batchError.message)}). The panel tries again every time you start the server; if it still can't write the script then, the start stops and says why instead of running the default script.`,
                params: { reason: sanitizeError(batchError.message) },
              });
            }

            logServerEvent(
              "server_install",
              `Installed PZ server to ${installPath} (${selectedBranch} branch)`,
            );

            // 2026-08-26 bug hunt: exit code 0 was trusted as sufficient proof
            // the game files were actually installed -- SteamCMD can exit 0
            // after a rate-limited, interrupted, or otherwise incomplete
            // download. The self-install-steamcmd-itself step above already
            // does an existsSync check on its own output for exactly this
            // reason; this carries that same habit to the install that
            // actually matters. Same PZ_INSTALL_MARKERS list DELETE
            // /delete-files uses to confirm a folder is a real PZ install --
            // one marker present is enough to call this usable, not a deep
            // validation.
            if (!hasPzInstallMarker(installPath)) {
              log.warn(
                `SteamCMD exited 0 but no recognizable PZ server files were found at ${installPath}`,
              );
              warnings.push({
                progressCode: ProgressCode.INSTALL_MISSING_GAME_FILES,
                message:
                  "SteamCMD reported success, but no recognizable game files were found at the install path. Check the SteamCMD log above for a hidden error (a rate limit or an interrupted download can still exit 0), and verify the install path before starting this server.",
              });
            }

            // PanelBridge goes in through the same delivery gate as every
            // other writer (bridgeDelivery.reconcileBridge), so a game folder
            // another profile already gets PanelBridge for from the Steam
            // Workshop is left alone. The profile doesn't exist yet, so a
            // pseudo-record stands in for it. Never throws.
            const bridgeSetup = await reconcileBridge(
              { id: null, installPath, serverPath: installPath, isRemote: false },
              { reason: "setup" },
            );
            if (bridgeSetup.actions.some((action) => action.kind === "installed" || action.kind === "updated")) {
              io.to("install").emit("install:log", {
                type: "stdout",
                text: "PanelBridge mod installed automatically",
                progressCode: ProgressCode.PANELBRIDGE_AUTO_INSTALLED,
                ...installEventScope,
              });
              log.info("PanelBridge mod auto-installed to server");
            }

            io.to("install").emit("install:complete", {
              success: true,
              message: "Server installed successfully",
              installPath,
              serverName,
              zomboidDataPath: zomboidPath, // Send back the computed data path
              serverConfigPath,
              branch: selectedBranch,
              // The wizard creates the server profile from this event: the
              // same host the legacy rconHost setting got (RCON_HOST in the
              // two-container Docker setup), not a hardcoded 127.0.0.1.
              rconHost: resolveEnvRconHost(),
              rconPort: safeRconPort,
              hasRconPassword: !!rconPassword,
              serverPort: safeServerPort,
              minMemory: safeMinMemory,
              maxMemory: safeMaxMemory,
              progressCode: ProgressCode.INSTALL_COMPLETE_SUCCESS,
              warnings,
              ...installEventScope,
            });
          } else if (killedByWatchdog) {
            const idleMinutes = STEAM_OPERATION_IDLE_TIMEOUT_MS / 60000;
            log.error(
              `SteamCMD produced no output for ${idleMinutes} minutes and was stopped`,
            );
            io.to("install").emit("install:complete", {
              success: false,
              message: `Installation was stopped after ${idleMinutes} minutes with no output from SteamCMD -- it may have stalled or lost its connection. Try again.`,
              output,
              progressCode: ProgressCode.INSTALL_WATCHDOG_KILLED,
              params: { minutes: idleMinutes },
              ...installEventScope,
            });
          } else {
            log.error(`SteamCMD exited with code ${code}`);
            io.to("install").emit("install:complete", {
              success: false,
              message: `Installation failed with exit code ${code}`,
              output,
              progressCode: ProgressCode.INSTALL_FAILED_EXIT_CODE,
              params: { code },
              ...installEventScope,
            });
          }

          // Clear active operation
          clearActiveSteamOperation(normalizedPath);
        });

        steamcmd.on("error", (error) => {
          // Clear active operation on error
          clearActiveSteamOperation(normalizedPath);

          log.error(`SteamCMD error: ${error.message}`);
          io.to("install").emit("install:complete", {
            success: false,
            message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
            progressCode: ProgressCode.STEAMCMD_RUN_FAILED,
            params: { reason: sanitizeError(error.message) },
            ...installEventScope,
          });
        });

        // All of steamcmd's own listeners are attached synchronously above --
        // this await, unlike one placed between spawn() and those .on() calls,
        // cannot lose an early 'close'/'error'/data event to a gap where
        // nothing was listening yet.
        await recordActiveSteamOperationPid(normalizedPath, steamcmd.pid);
      } catch (err) {
        // Self-heal (or anything before the real SteamCMD process attaches
        // its own listeners) failed -- the HTTP response was already sent
        // above, so report it the same way every other failure past that
        // point does: install:complete over the socket, not an HTTP error.
        clearActiveSteamOperation(normalizedPath);
        log.error(`Installation error: ${err.message}`);
        const isDownloadConflict =
          err.code === ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS;
        io.to("install").emit("install:complete", {
          success: false,
          message: isDownloadConflict
            ? err.message
            : needsSteamCmdSelfHeal
              ? `SteamCMD not found and auto-download failed: ${sanitizeError(err.message)}`
              : `Installation error: ${sanitizeError(err.message)}`,
          progressCode: isDownloadConflict
            ? err.code
            : needsSteamCmdSelfHeal
              ? ProgressCode.STEAMCMD_SELF_HEAL_FAILED
              : undefined,
          ...(needsSteamCmdSelfHeal && !isDownloadConflict
            ? { params: { reason: sanitizeError(err.message) } }
            : {}),
          ...installEventScope,
        });
      }
    })().catch((err) => {
      // Last-resort backstop: every branch above already has its own
      // try/catch and never rethrows -- this only exists so a genuine bug
      // in it becomes a logged error instead of an unhandled rejection
      // (server/index.js's own handler kills the whole panel process on
      // one of those).
      log.error(`Unexpected error after install self-heal: ${err.message}`);
      clearActiveSteamOperation(normalizedPath);
    });
  } catch (error) {
    if (activeOperationPath) {
      clearActiveSteamOperation(activeOperationPath);
    }
    log.error(`Installation error: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Quick Setup - Create new server config using existing files (no SteamCMD download)
router.post("/quick-setup", requirePermission("server.install"), async (req, res) => {
  try {
    const {
      serverName: suppliedServerName,
      zomboidDataPath,
      minMemory = 4,
      maxMemory = 8,
      adminPassword,
      serverPort = 16261,
      useUpnp = true,
      useNoSteam = false,
      useDebug = false,
      rconPassword,
      rconPort = 27015,
    } = req.body;
    // Refused, not stripped to fit the .ini: see utils/rconPassword.js.
    if (rconPasswordCannotBeStoredInIni(rconPassword)) {
      return res.status(400).json(rconPasswordUnsupportedCharsBody());
    }
    // Trimmed once, here: isValidServerName() judges the trimmed text, so the
    // untrimmed " MyServer " it accepted used to name the .ini "MyServer .ini".
    const serverName = trimmedServerName(suppliedServerName);
    // let, not const: host-vs-container translation below (see the
    // existence check further down) can substitute the container-side
    // equivalent of a host path the operator typed, so the rest of this
    // handler works against the real directory instead of one that only
    // makes sense from outside this container.
    let { installPath } = req.body;

    // Validate inputs
    if (!installPath || !serverName) {
      return res
        .status(400)
        .json({ error: "Missing required fields: installPath, serverName", code: ErrorCode.QUICK_SETUP_MISSING_FIELDS });
    }

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid install path", code: ErrorCode.INSTALL_PATH_INVALID });
    }

    if (!isValidServerName(serverName)) {
      return res.status(400).json({
        error:
          "Invalid server name. Use only letters, numbers, underscores, hyphens, and spaces (max 64 chars)",
        code: ErrorCode.SERVER_NAME_FORMAT_INVALID,
      });
    }

    if (zomboidDataPath && !isValidPath(zomboidDataPath)) {
      return res.status(400).json({ error: "Invalid Zomboid data path", code: ErrorCode.ZOMBOID_DATA_PATH_INVALID });
    }

    const adminPasswordRefusal = adminPasswordStartScriptRefusal(adminPassword);
    if (adminPasswordRefusal) {
      return res.status(400).json(adminPasswordRefusal);
    }

    // Check if server files exist
    const hasServerFilesAt = (candidatePath) =>
      fs.existsSync(path.join(candidatePath, "StartServer64.bat")) ||
      fs.existsSync(path.join(candidatePath, "start-server.sh")) ||
      fs.existsSync(path.join(candidatePath, "jre64"));

    // host-vs-container translation, 2026-09-09 (docker-unraid-onboarding,
    // rule 2: a translatable host path must SUCCEED with a note, not fail
    // politely -- see containerMountInfo.js's own header comment for what
    // this can and cannot do, and why). Only attempted when the raw typed
    // path fails the check below; a container-side path that's already
    // correct never touches this. Self-inspect requires the Docker socket
    // to be mounted -- absent by default (today's Unraid template doesn't
    // offer it), so on most installs this is a no-op and falls straight
    // through to the unchanged rejection below.
    let quickSetupPathTranslatedFrom = null;
    let quickSetupSelfInspect = null;
    if (!hasServerFilesAt(installPath)) {
      quickSetupSelfInspect = await inspectSelfContainerMounts();
      if (quickSetupSelfInspect.available) {
        const translated = translateHostPath(installPath, quickSetupSelfInspect.mounts);
        if (
          translated &&
          translated !== installPath &&
          hasServerFilesAt(translated)
        ) {
          log.info(
            `quick-setup: translated host path ${installPath} -> ${translated} via Docker self-inspect`,
          );
          quickSetupPathTranslatedFrom = installPath;
          installPath = translated;
        }
      }
    }

    if (!hasServerFilesAt(installPath)) {
      // A path we could not translate is not the same as a path we know
      // nothing about: when self-inspect DID run (the socket is mounted),
      // name what this container can actually see instead of a bare
      // not-found -- rule 4, no dead ends. When it didn't run at all (no
      // socket -- the common case), there is nothing more honest to say
      // than the original message, so it is left unchanged.
      const visibleMounts = quickSetupSelfInspect?.available
        ? quickSetupSelfInspect.mounts.map((m) => m.containerPath).filter(Boolean)
        : [];
      return res.status(400).json({
        error: visibleMounts.length
          ? `Server files not found at ${installPath}. This container can only see these mounted folders: ${visibleMounts.join(", ")}. If your Project Zomboid files live somewhere else on the host, point Docker's volume/bind mount at that folder first.`
          : "Server files not found. Make sure the path contains Project Zomboid dedicated server files.",
        code: ErrorCode.QUICK_SETUP_SERVER_FILES_NOT_FOUND,
      });
    }

    const { zomboidPath, serverConfigPath, usesEnvironmentDataPath } =
      resolveZomboidPaths(installPath, zomboidDataPath);

    // PATHS-1: same rule as /install above.
    if (!usesEnvironmentDataPath) {
      const dataPathCheck = checkZomboidDataPath(zomboidPath, { expand: false });
      if (!dataPathCheck.ok) {
        return res.status(400).json(dataPathCheck.body);
      }
    }

    // steamcmd-routes-running-check, 2026-09-08: unlike /install, this
    // route's own precondition just above GUARANTEES server files already
    // exist at installPath -- exactly the state an existing, possibly
    // running server is in. It then unconditionally rewrites the INI and
    // both start scripts via writeFileAtomic() below with nothing standing
    // in the way. See resolveTargetServerForRunningCheck's own comment for
    // why the shared serverManager singleton (Convention A) would answer
    // the wrong question for a route whose target is an arbitrary
    // caller-supplied path, not necessarily the active server.
    const { target: quickSetupTargetServer, sharing: quickSetupSharingServers } =
      await resolveTargetServerForRunningCheck(installPath, { serverName, zomboidDataPath });
    const quickSetupNotStoppedError = await checkGameFolderServersStopped(
      quickSetupTargetServer,
      quickSetupSharingServers,
      "running quick setup on this path",
    );
    if (quickSetupNotStoppedError) {
      return res
        .status(quickSetupNotStoppedError.status)
        .json(quickSetupNotStoppedError.body);
    }

    // steamcmd-ops-never-check-the-lifecycle-lock, 2026-09-09: see /install
    // above for the full reasoning -- same-server refusal only, no global
    // block.
    if (
      isLifecycleLockedForServer(quickSetupTargetServer.id) ||
      quickSetupSharingServers.some((server) => isLifecycleLockedForServer(server.id))
    ) {
      return res.status(409).json(lifecycleInProgressResponse());
    }

    // See /install above: no -nosteam profile on a Steam Workshop folder.
    if (useNoSteam === true && newProfileConflictsWithWorkshop({ installPath, useNoSteam }, await getServers())) {
      return res.status(409).json(noSteamWorkshopConflictResponse());
    }

    // Only the data folder: the game files already exist here, possibly
    // baked into an image on purpose, and the launch scripts written next
    // to them are regenerated before every start. The worlds are what
    // can't be lost.
    const quickSetupEphemeralError = formatEphemeralContainerPathError(zomboidPath);
    if (quickSetupEphemeralError) {
      return res.status(400).json({
        error: quickSetupEphemeralError.message,
        code: quickSetupEphemeralError.code,
        params: quickSetupEphemeralError.params,
      });
    }

    try {
      ensureWritableDirectory(installPath);
    } catch (directoryError) {
      const writableError = formatWritablePathError("install", installPath);
      return res.status(400).json({
        error: writableError.message,
        code: writableError.code,
        params: writableError.params,
      });
    }

    try {
      ensureWritableDirectory(serverConfigPath);
    } catch (directoryError) {
      const writableError = formatWritablePathError("data", zomboidPath);
      return res.status(400).json({
        error: writableError.message,
        code: writableError.code,
        params: writableError.params,
      });
    }

    // Validate numeric inputs -- same refuse-don't-coerce reasoning as
    // /install above. See 2026-08-23 validateInt-coerces audit.
    const minMemoryCheck = requireIntInRange(minMemory, MEMORY_GB_MIN, MIN_MEMORY_GB_MAX, "Minimum memory (GB)");
    if (!minMemoryCheck.ok) {
      return res.status(400).json({ error: minMemoryCheck.message, code: ErrorCode.INVALID_MIN_MEMORY });
    }
    const maxMemoryCheck = requireIntInRange(maxMemory, MEMORY_GB_MIN, MAX_MEMORY_GB_MAX, "Maximum memory (GB)");
    if (!maxMemoryCheck.ok) {
      return res.status(400).json({ error: maxMemoryCheck.message, code: ErrorCode.INVALID_MAX_MEMORY });
    }
    const serverPortCheck = requireIntInRange(serverPort, BIND_PORT_MIN, GAME_PORT_MAX, "Game port");
    if (!serverPortCheck.ok) {
      return res.status(400).json({ error: serverPortCheck.message, code: ErrorCode.INVALID_SERVER_PORT });
    }
    const rconPortCheck = requireIntInRange(rconPort, BIND_PORT_MIN, BIND_PORT_MAX, "RCON port");
    if (!rconPortCheck.ok) {
      return res.status(400).json({ error: rconPortCheck.message, code: ErrorCode.INVALID_RCON_PORT });
    }
    const safeMinMemory = minMemoryCheck.value;
    const safeMaxMemory = maxMemoryCheck.value;
    const safeServerPort = serverPortCheck.value;
    const safeRconPort = rconPortCheck.value;

    log.info(
      `Quick setup: Creating server config for ${serverName} using files from ${installPath}`,
    );

    // Same reasoning as /install above (2026-08-26 install-failure hunt
    // finding #6): the server files already exist (checked above), so a
    // failure past this point that self-heals on the next POST
    // /server/start (the INI pre-create) is reported as a warning, not a
    // flat failure that would send the operator looking for a problem in
    // files that are actually fine.
    const warnings = [];

    // Update settings
    await setSetting("serverPath", installPath);
    await setSetting("serverName", serverName);
    await setSetting("minMemory", safeMinMemory);
    await setSetting("maxMemory", safeMaxMemory);
    await setSetting("serverPort", safeServerPort);
    await setSetting("useUpnp", useUpnp);

    // zomboidPath is the folder as the game gets it (resolved, no trailing
    // separator); the same text goes into the start script and the profile.
    await setSetting("zomboidDataPath", zomboidPath);
    if (!zomboidDataPath) {
      log.info(
        `Using ${usesEnvironmentDataPath ? "configured" : "isolated"} data folder: ${zomboidPath}`,
      );
    }

    await setSetting("serverConfigPath", serverConfigPath);

    // Re-check immediately before creating configuration files in case the
    // selected mount changed during setup.
    try {
      ensureWritableDirectory(serverConfigPath);
    } catch (dirError) {
      // Keep the raw errno in the log even though the operator-facing text
      // below is friendlier -- someone debugging still needs it. See the
      // /install route's identical fix above for why this reuses
      // formatWritablePathError instead of the Linux-only, non-container-
      // aware message this used to hand-roll.
      log.error(
        `Data folder is not writable: ${zomboidPath} (${dirError.message})`,
      );
      const writableError = formatWritablePathError("data", zomboidPath);
      const bareMetalCommand =
        writableError.code === ErrorCode.WRITABLE_PATH_DATA_BAREMETAL
          ? `sudo install -d -m 0755 -o "$(whoami)" -g "$(whoami)" "${zomboidPath}"`
          : null;
      throw new Error(
        bareMetalCommand
          ? `${writableError.message} For example: ${bareMetalCommand}`
          : writableError.message,
      );
    }

    // Save RCON settings
    if (rconPassword) {
      await setSetting("rconPassword", rconPassword);
      await setSetting("rconPort", safeRconPort);
      await setSetting("rconHost", resolveEnvRconHost());
    }

    // Pre-create the INI with UPnP (+ RCON when set) so PZ reads them on
    // first boot -- the same block as /install. This used to run only with
    // an RCON password and never wrote UPnP=, so the wizard's UPnP switch
    // only saved the unused global useUpnp setting.
    try {
      const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
      if (!fs.existsSync(iniPath)) {
        if (!fs.existsSync(serverConfigPath)) {
          fs.mkdirSync(serverConfigPath, { recursive: true });
        }
        const lines = [
          "# Auto-generated by Zomboid Control Panel",
          "# PZ will add remaining default settings on first server start",
          `UPnP=${useUpnp ? "true" : "false"}`,
        ];
        if (rconPassword) {
          lines.push(`RCONPort=${safeRconPort}`, `RCONPassword=${rconPassword}`);
        }
        writeFileAtomic(iniPath, lines.join("\n") + "\n", {
          encoding: "utf-8",
          mode: 0o600,
        });
        log.info(
          `Pre-created INI at ${iniPath} (UPnP=${useUpnp}${rconPassword ? ", RCON configured" : ""})`,
        );
      }
    } catch (iniError) {
      log.warn(`Failed to pre-create INI: ${iniError.message}`);
      const permissionHint =
        iniError.code === "EACCES"
          ? ` ${formatWritablePathError("data", serverConfigPath).message}`
          : "";
      warnings.push({
        progressCode: ProgressCode.INSTALL_RCON_INI_PRECREATE_FAILED,
        message: `Could not pre-write ${rconPassword ? "the RCON password" : "the UPnP setting"} into the server config (${sanitizeError(iniError.message)}).${permissionHint} This is retried automatically the next time you start the server.`,
        params: { reason: sanitizeError(iniError.message) },
      });
    }

    // Generate custom startup scripts
    const scripts = generateStartupScripts({
      installPath,
      serverName,
      minMemory: safeMinMemory,
      maxMemory: safeMaxMemory,
      zomboidDataPath: zomboidPath,
      adminPassword,
      serverPort: safeServerPort,
      useNoSteam,
      useDebug,
    });

    const batchPath = path.join(installPath, `StartServer_${serverName}.bat`);
    writeFileAtomic(batchPath, scripts.bat, {
      encoding: "utf8",
      // security audit L1: the .bat embeds -adminpassword; keep it
      // owner-only like the .sh (0750) instead of the umask default.
      mode: 0o600,
    });
    log.info(`Created custom startup batch: ${batchPath}`);

    const shellPath = path.join(installPath, `start-server_${serverName}.sh`);
    writeFileAtomic(shellPath, scripts.sh.replace(/\r\n/g, "\n"), {
      encoding: "utf8",
      mode: 0o750,
    });
    log.info(`Created custom startup script: ${shellPath}`);

    const startupScript =
      process.platform === "win32"
        ? `StartServer_${serverName}.bat`
        : `start-server_${serverName}.sh`;

    // Same delivery gate as the install wizard above (never throws).
    const bridgeSetup = await reconcileBridge(
      { id: null, installPath, serverPath: installPath, isRemote: false },
      { reason: "setup" },
    );
    const panelBridgeInstalled = bridgeSetup.actions.some(
      (action) => action.kind === "installed" || action.kind === "updated",
    );
    if (panelBridgeInstalled) log.info("PanelBridge mod auto-installed to server");

    await logServerEventBestEffort(
      "server_quick_setup",
      `Created server config for ${serverName} using existing files at ${installPath}`,
    );

    res.json({
      success: true,
      message: "Server configuration created successfully",
      installPath,
      // Set only when hasServerFilesAt() failed on the path exactly as
      // typed and a Docker self-inspect translation found the real
      // location instead -- rule 2 ("succeed with a note"), never present
      // on the common no-translation path.
      pathTranslatedFrom: quickSetupPathTranslatedFrom,
      serverName,
      zomboidDataPath: zomboidPath, // Send back the computed data path
      serverConfigPath,
      batchFile: startupScript,
      // See /install's install:complete: the wizard's profile uses this.
      rconHost: resolveEnvRconHost(),
      rconPort: safeRconPort,
      hasRconPassword: !!rconPassword,
      serverPort: safeServerPort,
      minMemory: safeMinMemory,
      maxMemory: safeMaxMemory,
      panelBridgeInstalled,
      warnings,
    });
  } catch (error) {
    log.error(`Quick setup error: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Configure RCON in server's .ini file
router.post("/configure-rcon", requirePermission("server.configure"), async (req, res) => {
  try {
    const { rconPassword, rconPort: rawRconPort = 27015 } = req.body || {};
    // Refused, not coerced: see 2026-08-23 validateInt-coerces audit.
    const rconPortCheck = requireIntInRange(rawRconPort, BIND_PORT_MIN, BIND_PORT_MAX, "RCON port");
    if (!rconPortCheck.ok) {
      return res.status(400).json({ error: rconPortCheck.message, code: ErrorCode.INVALID_RCON_PORT });
    }
    const rconPort = rconPortCheck.value;

    if (!rconPassword) {
      return res.status(400).json({ error: "RCON password is required", code: ErrorCode.CONFIGURE_RCON_PASSWORD_REQUIRED });
    }
    // Refused, not stripped to fit the .ini: see utils/rconPassword.js.
    if (rconPasswordCannotBeStoredInIni(rconPassword)) {
      return res.status(400).json(rconPasswordUnsupportedCharsBody());
    }

    // Get the server config path from active server or settings -- ONE
    // read, not two (split-derivation sweep, 2026-09-07).
    const { serverConfigPath, serverName, configPathRefused, configRefusal } =
      await getActiveServerPaths();

    if (configPathRefused) {
      return res.status(400).json(configRefusal);
    }
    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set. Please run installation first.",
        code: ErrorCode.SERVER_CONFIG_PATH_NOT_SET,
      });
    }

    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: `Server config not found at ${iniPath}. Start the server once first to generate the config file.`,
        code: ErrorCode.SERVER_CONFIG_FILE_NOT_FOUND,
      });
    }

    // Read and update the ini file. Locked per-path so this can't interleave
    // with ensureRconConfigured() or another config-save racing the same file.
    await withFileLock(iniPath, async () => {
      const { content: normalized, lineEnding } = withOriginalLineEnding(
        fs.readFileSync(iniPath, "utf-8"),
      );
      let content = normalized;

      // The password goes in as it is: it holds no line break or "=" (the
      // check above), and nothing else in a value is special to the game.
      content = setIniKeyLine(content, "RCONPassword", rconPassword);
      content = setIniKeyLine(content, "RCONPort", rconPort);

      writeFileAtomic(iniPath, restoreLineEnding(content, lineEnding), { encoding: "utf-8", mode: 0o600 });
    });

    // Also save to app settings
    await setSetting("rconPassword", rconPassword);
    await setSetting("rconPort", rconPort);
    await setSetting("rconHost", resolveEnvRconHost());

    log.info(`RCON configured in ${iniPath}`);
    res.json({
      success: true,
      message: `RCON configured successfully. Restart the server for changes to take effect.`,
      iniPath,
    });
  } catch (error) {
    log.error(`Failed to configure RCON: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Configure server network settings (port, UPnP) in .ini file
// Writes just the UPnP= line into an existing server .ini. Extracted from
// /configure-network's own UPnP handling (below) so PUT /:id (server edit,
// servers.js) can reuse it instead of duplicating the read/replace/write
// logic -- deliberately narrow: does NOT touch DefaultPort/UDPPort, which
// stay /configure-network's own concern, so calling this from a second
// site never triggers a port change as a side effect. Returns
// {applied:false, reason} rather than throwing when the ini doesn't exist
// yet (a server that has never booted has no ini to edit) -- the caller
// decides whether that's worth surfacing to the operator.
export async function applyUpnpToIni(serverConfigPath, serverName, useUpnp) {
  const iniPath = path.join(serverConfigPath, `${serverName}.ini`);
  if (!fs.existsSync(iniPath)) {
    return { applied: false, reason: `Server config not found at ${iniPath}` };
  }
  try {
    await withFileLock(iniPath, async () => {
      const { content: normalized, lineEnding } = withOriginalLineEnding(
        fs.readFileSync(iniPath, "utf-8"),
      );
      const upnpValue = useUpnp ? "true" : "false";
      const content = setIniKeyLine(normalized, "UPnP", upnpValue);
      writeFileAtomic(iniPath, restoreLineEnding(content, lineEnding), { encoding: "utf-8", mode: 0o600 });
    });
    return { applied: true };
  } catch (error) {
    return { applied: false, reason: sanitizeError(error.message) };
  }
}

router.post("/configure-network", requirePermission("server.configure"), async (req, res) => {
  try {
    const { serverPort: rawServerPort = 16261, useUpnp = true } = req.body || {};
    // Refused, not coerced: see 2026-08-23 validateInt-coerces audit.
    const serverPortCheck = requireIntInRange(rawServerPort, BIND_PORT_MIN, GAME_PORT_MAX, "Game port");
    if (!serverPortCheck.ok) {
      return res.status(400).json({ error: serverPortCheck.message, code: ErrorCode.INVALID_SERVER_PORT });
    }
    const serverPort = serverPortCheck.value;
    if (typeof useUpnp !== "boolean") {
      return res.status(400).json({
        error: "useUpnp must be a boolean",
      });
    }

    // Get the server config path from active server or settings -- ONE
    // read, not two (split-derivation sweep, 2026-09-07).
    const { serverConfigPath, serverName, configPathRefused, configRefusal } =
      await getActiveServerPaths();

    if (configPathRefused) {
      return res.status(400).json(configRefusal);
    }
    if (!serverConfigPath || !serverName) {
      return res.status(400).json({
        error: "Server config path not set. Please run installation first.",
        code: ErrorCode.SERVER_CONFIG_PATH_NOT_SET,
      });
    }

    const iniPath = path.join(serverConfigPath, `${serverName}.ini`);

    if (!fs.existsSync(iniPath)) {
      return res.status(400).json({
        error: `Server config not found at ${iniPath}. Start the server once first to generate the config file.`,
        code: ErrorCode.SERVER_CONFIG_FILE_NOT_FOUND,
      });
    }

    // Read and update the ini file. Locked per-path for the same reason as
    // the RCON-config endpoint above.
    await withFileLock(iniPath, async () => {
      const { content: normalized, lineEnding } = withOriginalLineEnding(
        fs.readFileSync(iniPath, "utf-8"),
      );
      let content = normalized;

      // Update DefaultPort, then UDPPort (DefaultPort + 1)
      content = setIniKeyLine(content, "DefaultPort", serverPort);
      content = setIniKeyLine(content, "UDPPort", serverPort + 1);

      writeFileAtomic(iniPath, restoreLineEnding(content, lineEnding), { encoding: "utf-8", mode: 0o600 });
    });

    // UPnP itself is applyUpnpToIni()'s own concern now -- shared with
    // PUT /:id (servers.js) so a server's UPnP choice takes effect there
    // too, not only when re-saved through this page. withFileLock's
    // per-path promise queue (fileWriteQueue.js) serializes this against
    // the port write above; both still land, just as two writes instead of
    // one, and never interleaved.
    await applyUpnpToIni(serverConfigPath, serverName, useUpnp);

    // Also save to app settings
    await setSetting("serverPort", serverPort);
    await setSetting("useUpnp", useUpnp);

    log.info(
      `Network settings configured in ${iniPath}: port=${serverPort}, UPnP=${useUpnp ? "true" : "false"}`,
    );
    res.json({
      success: true,
      message: `Network settings configured successfully. Restart the server for changes to take effect.`,
      iniPath,
      settings: {
        defaultPort: serverPort,
        udpPort: serverPort + 1,
        upnp: useUpnp,
      },
    });
  } catch (error) {
    log.error(`Failed to configure network settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Alarm - sound building alarm
router.post("/alarm", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.alarm();
    await logServerEventBestEffort("alarm");
    res.json(result);
  } catch (error) {
    log.error(`Failed to trigger alarm: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Remove zombies
router.post("/removezombies", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.removeZombies();
    await logServerEventBestEffort("removezombies");
    res.json(result);
  } catch (error) {
    log.error(`Failed to remove zombies: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Reload Lua script
router.post("/reloadlua", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { filename } = req.body || {};

    if (!filename) {
      return res.status(400).json({ error: "Filename is required", code: ErrorCode.RELOAD_LUA_FILENAME_REQUIRED });
    }

    // Validate filename - allow alphanumeric, underscores, dots, and forward slashes only
    // Block backslashes and '..' to prevent path traversal
    if (!/^[a-zA-Z0-9_/.\-]+\.lua$/.test(filename) || filename.includes("..")) {
      return res.status(400).json({ error: "Invalid filename format", code: ErrorCode.RELOAD_LUA_INVALID_FILENAME });
    }

    const result = await rconService.reloadLua(filename);
    await logServerEventBestEffort("reloadlua", filename);
    res.json(result);
  } catch (error) {
    log.error(`Failed to reload Lua: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set log level
router.post("/log", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { type, level } = req.body || {};

    if (!type || !level) {
      return res.status(400).json({ error: "Type and level are required", code: ErrorCode.LOG_TYPE_LEVEL_REQUIRED });
    }

    const validTypes = [
      "General",
      "Network",
      "Multiplayer",
      "Voice",
      "Packet",
      "NetworkFileDebug",
      "Lua",
      "Mod",
      "Sound",
      "Zombie",
      "Combat",
      "Objects",
      "Fireplace",
      "Radio",
      "MapLoading",
      "Clothing",
      "Animation",
      "Asset",
      "Script",
      "Shader",
      "Input",
      "Recipe",
      "ActionSystem",
      "IsoRegion",
      "UniTests",
      "FileIO",
      "Ownership",
      "Death",
      "Damage",
      "Statistic",
      "Vehicle",
      "Checksum",
    ];

    const validLevels = ["Trace", "Debug", "General", "Warning", "Error"];

    if (!validTypes.includes(type)) {
      return res
        .status(400)
        .json({ error: `Invalid log type. Valid: ${validTypes.join(", ")}`, code: ErrorCode.LOG_INVALID_TYPE });
    }

    if (!validLevels.includes(level)) {
      return res
        .status(400)
        .json({ error: `Invalid log level. Valid: ${validLevels.join(", ")}`, code: ErrorCode.LOG_INVALID_LEVEL });
    }

    const result = await rconService.setLogLevel(type, level);
    res.json(result);
  } catch (error) {
    log.error(`Failed to set log level: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Server statistics
router.post("/stats", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const { mode, period } = req.body || {};

    if (!mode) {
      return res.status(400).json({ error: "Mode is required", code: ErrorCode.STATS_MODE_REQUIRED });
    }

    const validModes = ["none", "file", "console", "all"];
    if (!validModes.includes(mode.toLowerCase())) {
      return res
        .status(400)
        .json({ error: `Invalid mode. Valid: ${validModes.join(", ")}`, code: ErrorCode.STATS_INVALID_MODE });
    }

    // Coerced, not refused: no client caller sets this today (unused API
    // surface), and an out-of-range value already falls back to `null`
    // (stats reporting off) rather than a plausible-looking wrong number --
    // see 2026-08-23 validateInt-coerces audit.
    const validPeriod = period ? coerceIntInRange(period, 1, 3600, null) : null;

    const result = await rconService.setStats(mode, validPeriod);
    res.json(result);
  } catch (error) {
    log.error(`Failed to set stats: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Release safehouse
router.post("/releasesafehouse", requirePermission("server.world_events"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");
    const result = await rconService.releaseSafehouse();
    res.json(result);
  } catch (error) {
    log.error(`Failed to release safehouse: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Update server using SteamCMD
router.post("/steam-update", requirePermission("server.install"), async (req, res) => {
  let activeOperationPath = null;
  try {
    let {
      steamcmdPath,
      installPath,
      branch,
      useUnstable = false,
      validateFiles = false,
    } = req.body;

    // Determine branch - support both new 'branch' param and legacy 'useUnstable'
    const selectedBranch = branch || (useUnstable ? "unstable" : "stable");

    // Auto-load steamcmdPath from settings if not provided
    if (!steamcmdPath) {
      steamcmdPath = await getSetting("steamcmdPath");
    }

    if (!steamcmdPath || !installPath) {
      return res
        .status(400)
        .json({ error: "Missing required fields: steamcmdPath, installPath", code: ErrorCode.STEAM_UPDATE_MISSING_FIELDS });
    }

    if (!isValidPath(steamcmdPath)) {
      return res.status(400).json({ error: "Invalid SteamCMD path", code: ErrorCode.STEAMCMD_PATH_INVALID });
    }
    const steamcmdFolderRefused = steamCmdFolderRefusal(steamcmdPath);
    if (steamcmdFolderRefused) return res.status(400).json(steamcmdFolderRefused);

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid install path", code: ErrorCode.INSTALL_PATH_INVALID });
    }

    // Check if server is running - cannot update while running.
    //
    // steamcmd-routes-running-check, 2026-09-08: this used to check
    // `serverManager.getServerProcessDetails()` on the shared serverManager
    // singleton -- scoped to whichever server serverManager itself has
    // loaded, NOT necessarily the server at `installPath`, which arrives raw
    // from req.body with no reload or reconciliation against it first. On a
    // host managing more than one server, updating server B's installPath
    // while serverManager has server A loaded checked A's running-state,
    // completely unrelated to whether B (whose files SteamCMD is about to
    // validate/overwrite) is running -- the identical shape
    // checkSpecificServerStopped() itself had before this file's own
    // 8f04b051, except here the wrong answer was a false GREEN LIGHT, not
    // just a missing check. See resolveTargetServerForRunningCheck's own
    // comment for the fix.
    const { target: steamUpdateTargetServer, sharing: steamUpdateSharingServers } =
      await resolveTargetServerForRunningCheck(installPath, {});
    const steamUpdateNotStoppedError = await checkGameFolderServersStopped(
      steamUpdateTargetServer,
      steamUpdateSharingServers,
      "updating it",
    );
    if (steamUpdateNotStoppedError) {
      return res
        .status(steamUpdateNotStoppedError.status)
        .json(steamUpdateNotStoppedError.body);
    }

    // steamcmd-ops-never-check-the-lifecycle-lock, 2026-09-09: see /install
    // above for the full reasoning -- same-server refusal only, no global
    // block.
    if (
      isLifecycleLockedForServer(steamUpdateTargetServer.id) ||
      steamUpdateSharingServers.some((server) => isLifecycleLockedForServer(server.id))
    ) {
      return res.status(409).json(lifecycleInProgressResponse());
    }

    // Auto-download SteamCMD instead of hard-failing on either platform —
    // see ensureSteamCmdInstalled (windows-steamcmd-selfheal, 2026-09-10,
    // closed the Windows-only gap this comment used to describe as a
    // Linux-only capability).
    // Persist steamcmdPath as the configured setting before resolving an
    // executable from it -- see saveAndResolveSteamCmdExe's header comment
    // (CodeQL js/command-line-injection #13).
    let steamcmdExe = await saveAndResolveSteamCmdExe(steamcmdPath);
    const needsSteamCmdSelfHeal = !steamcmdExe || !fs.existsSync(steamcmdExe);

    // Prevent concurrent operations on the same install path. Deliberately
    // placed HERE -- before self-heal now, not after it (see
    // install-selfheal-background below for why) -- matching POST /install's
    // check/claim placement (which does it in this same order, right before
    // its own activeSteamOperations.set()). This check used to sit BEFORE
    // saveAndResolveSteamCmdExe's await, which meant two concurrent
    // steam-update requests for the same installPath could both pass this
    // check before either claimed the path, then both spawn SteamCMD
    // against it concurrently (manifest lock contention / interleaved
    // writes) -- proven via
    // server/tests/steamUpdateConcurrency.test.js. Nothing between this
    // check and the claim below is awaited, so there is no gap left for a
    // second request to slip through.
    const normalizedPath = path.normalize(installPath).toLowerCase();
    if (hasActiveSteamOperation(normalizedPath)) {
      return res.status(409).json({
        error:
          "A Steam operation is already in progress for this server. Please wait for it to complete.",
        code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_SERVER,
      });
    }

    // install-selfheal-background, 2026-09-18: same fix as POST /install --
    // steamcmdDownloadInProgress is the single-flight guard
    // ensureSteamCmdInstalled() itself claims synchronously. Checked here
    // too so a request that would only discover the conflict once self-heal
    // starts in the background below still gets the same immediate 409 it
    // always has, instead of a misleading "started" followed by a failure.
    if (needsSteamCmdSelfHeal && steamcmdDownloadInProgress) {
      return res.status(409).json({
        error: "A SteamCMD download is already in progress",
        code: ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS,
      });
    }

    const operation = validateFiles ? "verification" : "update";
    log.info(`Starting PZ server ${operation} (branch: ${selectedBranch})...`);

    // Mark operation as active
    activeSteamOperations.set(normalizedPath, {
      type: operation,
      startTime: Date.now(),
      lastOutputAt: Date.now(),
      branch: selectedBranch,
    });
    activeOperationPath = normalizedPath;

    // Manifest recovery only once this request owns the path (same order as
    // POST /install): run before the concurrency check above, a refused
    // second request deleted the manifest of the update already running.
    try {
      const recovery = recoverMismatchedSteamBranchManifest(
        installPath,
        selectedBranch,
      );
      if (recovery) {
        log.warn(
          `Reset stale SteamCMD branch manifest (${recovery.mountedBranch} -> ${recovery.targetBranch}); backup: ${recovery.backupPath}`,
        );
      }
    } catch (error) {
      log.warn(`Could not inspect SteamCMD branch manifest: ${error.message}`);
    }

    try {
      const recovery = recoverBlockedSteamManifest(installPath);
      if (recovery) {
        log.warn(
          `Reset SteamCMD manifest stuck in access-denied state 0x6; backup: ${recovery.backupPath}`,
        );
      }
    } catch (error) {
      log.warn(`Could not reset blocked SteamCMD manifest: ${error.message}`);
    }

    const io = req.app.get("io");

    // steam-update-events-cross-server-contamination, 2026-09-18: the
    // concurrency guard above is scoped per installPath, so two operators
    // (or one operator with two servers registered) CAN legitimately run an
    // update/verify on two different servers at the same time. steam:start/
    // steam:log/steam:complete used to carry no identifier at all -- every
    // connected client received every event regardless of which server's
    // dialog it had open, so a second server's log lines interleaved into
    // the first dialog's log panel, and worse, its steam:complete could
    // close out the WRONG dialog as success/failure. installPath (the exact
    // string this request received, not the normalized/lowercased form used
    // for the concurrency map -- the client echoes back the identical
    // string it sent, so an exact-string comparison on the client needs no
    // normalization of its own) lets the client filter events down to only
    // the operation its own open dialog started.
    const steamEventScope = { installPath };

    // install-selfheal-background, 2026-09-18 (should-steamcmd-self-heal-
    // hold-the-http-response-or-run-in-background): see POST /install's own
    // comment for the full reasoning -- ensureSteamCmdInstalled's
    // download+extract+first-run can take minutes, so awaiting it before
    // responding (as this route used to) held the HTTP response open well
    // past the client's own request timeout. Respond now and run self-heal
    // + the real update/verify in the background; every failure branch from
    // here on emits its own steam:complete (scoped by steamEventScope, same
    // as every other failure branch below) instead of an HTTP error.
    res.json({
      success: true,
      message: `Server ${operation} started`,
    });

    (async () => {
      try {
        if (needsSteamCmdSelfHeal) {
          steamcmdExe = await ensureSteamCmdInstalled(steamcmdPath, io);
        }

        // Build SteamCMD command
        const betaArgs = getBetaArgs(selectedBranch);
        const loginArgs = await getSteamLoginArgs();
        const steamcmdArgs = [
          "+force_install_dir",
          installPath,
          ...loginArgs,
          // Fresh app info first: otherwise SteamCMD installs the build its
          // cached app info names for the branch, which can be weeks old.
          "+app_info_update",
          "1",
          "+app_update",
          "380870",
          ...betaArgs,
          "validate",
          "+quit",
        ];

        // Emit start event
        io.to("install").emit("steam:start", {
          type: validateFiles ? "verify" : "update",
          message: validateFiles ? "Verifying game files..." : "Updating server...",
          progressCode: validateFiles
            ? ProgressCode.STEAM_START_VERIFY
            : ProgressCode.STEAM_START_UPDATE,
          ...steamEventScope,
        });

        const updateSpawnOpts = { cwd: steamcmdPath };
        if (!isWindows) {
          updateSpawnOpts.env = buildLinuxSteamCmdEnv(steamcmdPath);
        }
        const steamcmd = spawn(steamcmdExe, steamcmdArgs, updateSpawnOpts);
        activeSteamOperations.get(normalizedPath).watchdog = setInterval(() => {
          const activeOperation = activeSteamOperations.get(normalizedPath);
          if (!activeOperation) return;
          if (!isSteamOperationIdle(activeOperation)) return;

          log.error(
            `SteamCMD ${activeOperation.type} produced no output for ${STEAM_OPERATION_IDLE_TIMEOUT_MS / 60000} minutes; terminating the stalled process`,
          );
          steamcmd.kill();
        }, 30_000);
        activeSteamOperations.get(normalizedPath).watchdog.unref?.();

        let output = "";
        let stdoutBuffer = "";
        let stderrBuffer = "";

        steamcmd.stdout.on("data", (data) => {
          const operation = activeSteamOperations.get(normalizedPath);
          if (operation) operation.lastOutputAt = Date.now();
          const text = data.toString();
          output += text;
          stdoutBuffer += text;

          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() || "";

          for (const line of lines) {
            if (line.trim()) {
              emitRawSteamCmdLine(io, "steam:log", "stdout", line, steamEventScope);
              log.info(`SteamCMD: ${line}`);
            }
          }
        });

        steamcmd.stderr.on("data", (data) => {
          const operation = activeSteamOperations.get(normalizedPath);
          if (operation) operation.lastOutputAt = Date.now();
          const text = data.toString();
          output += text;
          stderrBuffer += text;

          // Buffer stderr lines like stdout for consistent output
          const lines = stderrBuffer.split(/\r?\n/);
          stderrBuffer = lines.pop() || "";

          for (const line of lines) {
            if (line.trim()) {
              emitRawSteamCmdLine(io, "steam:log", "stderr", line, steamEventScope);
              log.warn(`SteamCMD stderr: ${line}`);
            }
          }
        });

        steamcmd.on("close", (code) => {
          // Flush remaining buffers
          if (stdoutBuffer.trim()) {
            emitRawSteamCmdLine(io, "steam:log", "stdout", stdoutBuffer.trim(), steamEventScope);
          }
          if (stderrBuffer.trim()) {
            emitRawSteamCmdLine(io, "steam:log", "stderr", stderrBuffer.trim(), steamEventScope);
          }

          // Clear active operation
          clearActiveSteamOperation(normalizedPath);

          // continuous-bug-hunt, 2026-09-18 (steamcmd-success-truth round):
          // SteamCMD is well documented to exit 0 even when +app_update failed
          // partway -- a rejected/incomplete download, a corrupted manifest, a
          // disk-space failure, or a config-resolution failure all print one or
          // more "ERROR!"-prefixed lines (or, for the config case specifically,
          // "Missing configuration") and then still let the child process exit
          // 0. code===0 alone was trusted as sufficient proof of success here,
          // the identical exit-0-lies gap POST /install already closed via
          // hasPzInstallMarker() (2026-08-26) -- that exact fix doesn't
          // transfer to this route unmodified, though: this one updates/
          // validates an ALREADY-installed server, so the marker files it
          // would check are already sitting on disk from before this run and
          // prove nothing about whether THIS update actually succeeded. The
          // signal that does exist here is SteamCMD's own captured output --
          // scan it for its own documented failure lines before trusting the
          // exit code, same distrust, different evidence.
          const steamCmdReportedError =
            /^\s*ERROR!/im.test(output) || /missing configuration/i.test(output);
          const success = code === 0 && !steamCmdReportedError;
          const steamDepotAccessDenied =
            /app ['"]?380870['"]? state is 0x6/i.test(output) ||
            /manifest.*access denied/i.test(output);
          const failureMessage = steamDepotAccessDenied
            ? "SteamCMD could not access a Project Zomboid depot manifest. Your installed server files were not changed. Retry later; if it persists, update using a Steam account that owns Project Zomboid."
            : steamCmdReportedError
              ? `SteamCMD exited cleanly (code 0) but reported an error in its own output during the ${operation} -- check the SteamCMD log above for the exact line. Your installed server files may be incomplete or unchanged.`
              : `Server ${operation} failed with code ${code}`;

          // "update" vs "verification" is a word choice, not a value -- own
          // codes per direction, not a shared template with `operation`
          // substituted in (see ProgressCode's file header, params-vs-variant
          // rule). steamDepotAccessDenied is independent of that distinction.
          let completeProgressCode;
          let completeParams;
          if (success) {
            completeProgressCode = validateFiles
              ? ProgressCode.STEAM_VERIFY_COMPLETE_SUCCESS
              : ProgressCode.STEAM_UPDATE_COMPLETE_SUCCESS;
          } else if (steamDepotAccessDenied) {
            completeProgressCode = ProgressCode.STEAM_DEPOT_ACCESS_DENIED;
          } else {
            completeProgressCode = validateFiles
              ? ProgressCode.STEAM_VERIFY_FAILED
              : ProgressCode.STEAM_UPDATE_FAILED;
            completeParams = { code };
          }

          io.to("install").emit("steam:complete", {
            success,
            message: success
              ? `Server ${operation} completed successfully`
              : failureMessage,
            progressCode: completeProgressCode,
            ...(completeParams ? { params: completeParams } : {}),
            ...steamEventScope,
          });

          // After successful update, re-check update status so banner clears
          if (success) {
            warnIfMountedSteamBranchDiffers(installPath, selectedBranch, operation);
            try {
              const updateChecker = req.app.get("updateChecker");
              if (updateChecker) {
                setTimeout(() => updateChecker.checkForUpdates(true), 3000);
              }
            } catch (e) {
              // Non-critical
            }
          }

          logServerEvent(
            success ? "server_update" : "server_update_failed",
            `Server ${operation} ${success ? "completed" : "failed"}`,
          ).catch((e) => log.error("Failed to log server event:", e));

          log.info(`SteamCMD ${operation} finished with code ${code}`);
        });

        steamcmd.on("error", (error) => {
          // Clear active operation on error
          clearActiveSteamOperation(normalizedPath);

          io.to("install").emit("steam:complete", {
            success: false,
            message: `Failed to run SteamCMD: ${sanitizeError(error.message)}`,
            progressCode: ProgressCode.STEAMCMD_RUN_FAILED,
            params: { reason: sanitizeError(error.message) },
            ...steamEventScope,
          });
          log.error(`SteamCMD error: ${error.message}`);
        });

        // All of steamcmd's own listeners are attached synchronously above --
        // this await, unlike one placed between spawn() and those .on() calls,
        // cannot lose an early 'close'/'error'/data event to a gap where
        // nothing was listening yet.
        await recordActiveSteamOperationPid(normalizedPath, steamcmd.pid);
      } catch (err) {
        // Self-heal (or anything before the real SteamCMD process attaches
        // its own listeners) failed -- the HTTP response was already sent
        // above, so report it the same way every other failure past that
        // point does: steam:complete over the socket, not an HTTP error.
        clearActiveSteamOperation(normalizedPath);
        log.error(`Steam update failed: ${err.message}`);
        const isDownloadConflict =
          err.code === ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS;
        io.to("install").emit("steam:complete", {
          success: false,
          message: isDownloadConflict
            ? err.message
            : needsSteamCmdSelfHeal
              ? `SteamCMD not found and auto-download failed: ${sanitizeError(err.message)}`
              : `Steam ${operation} error: ${sanitizeError(err.message)}`,
          progressCode: isDownloadConflict
            ? err.code
            : needsSteamCmdSelfHeal
              ? ProgressCode.STEAMCMD_SELF_HEAL_FAILED
              : undefined,
          ...(needsSteamCmdSelfHeal && !isDownloadConflict
            ? { params: { reason: sanitizeError(err.message) } }
            : {}),
          ...steamEventScope,
        });
      }
    })().catch((err) => {
      // Last-resort backstop: every branch above already has its own
      // try/catch and never rethrows -- this only exists so a genuine bug
      // in it becomes a logged error instead of an unhandled rejection
      // (server/index.js's own handler kills the whole panel process on
      // one of those).
      log.error(`Unexpected error after steam-update self-heal: ${err.message}`);
      clearActiveSteamOperation(normalizedPath);
    });
  } catch (error) {
    if (activeOperationPath) {
      clearActiveSteamOperation(activeOperationPath);
    }
    log.error(`Steam update failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Auto-download and install SteamCMD
router.post("/steamcmd/download", requirePermission("server.install"), async (req, res) => {
  try {
    log.info(`POST /steamcmd/download (platform=${process.platform})`);
    const defaultPath = isWindows
      ? "C:\\SteamCMD"
      : [
          "/usr/games",
          "/usr/bin",
          path.join(os.homedir(), "steamcmd"),
          "/opt/steamcmd",
          "/usr/local/bin",
        ].find(
          (p) =>
            fs.existsSync(path.join(p, "steamcmd.sh")) ||
            fs.existsSync(path.join(p, "steamcmd")),
        ) || path.join(os.homedir(), "steamcmd");
    // An empty or blank field means "the default location" (the setup
    // wizard sends "" when the SteamCMD path box is left empty); a
    // destructuring default only applied to undefined, so "" was refused.
    const requestedInstallPath = req.body?.installPath;
    const installPath =
      (typeof requestedInstallPath === "string"
        ? requestedInstallPath.trim()
        : requestedInstallPath) || defaultPath;

    if (!isValidPath(installPath)) {
      return res.status(400).json({ error: "Invalid installation path", code: ErrorCode.STEAMCMD_DOWNLOAD_INVALID_PATH });
    }
    const steamcmdFolderRefused = steamCmdFolderRefusal(installPath);
    if (steamcmdFolderRefused) return res.status(400).json(steamcmdFolderRefused);

    // Claim the guard NOW, before the first `await` below -- mirrors
    // panelUpdateChecker.js's isDownloading (see its own comment at
    // downloadUpdate() for the double-click corruption bug that ordering
    // exists to prevent: claiming it after an await leaves a TOCTOU window
    // where a second overlapping request reads the flag still false and
    // passes this same check too). Released at every place below where this
    // attempt is done writing to zipPath/tarPath -- both success and
    // failure -- not just at the end of the function, since the actual
    // download/extract runs in the background after this handler responds.
    if (steamcmdDownloadInProgress) {
      return res.status(409).json({
        error: "A SteamCMD download is already in progress",
        code: ErrorCode.STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS,
      });
    }
    steamcmdDownloadInProgress = true;

    // This route's whole job is provisioning SteamCMD at installPath --
    // persist it as the configured steamcmdPath setting now, before
    // runSteamCmdFirstTimeSetup()'s spawn() resolves an executable from it
    // below (CodeQL js/command-line-injection #297; see
    // saveAndResolveSteamCmdExe's header comment). Also makes /install and
    // /steam-update find this location afterward without the operator
    // re-typing it.
    const configuredSteamcmdPath = await getSetting("steamcmdPath");
    if (configuredSteamcmdPath !== installPath) {
      await setSetting("steamcmdPath", installPath);
    }

    const io = req.app.get("io");

    // Create directory if it doesn't exist
    if (!fs.existsSync(installPath)) {
      fs.mkdirSync(installPath, { recursive: true });
    }

    if (isWindows) {
      io.to("install").emit("steamcmd:status", {
        status: "downloading",
        message: "Downloading SteamCMD...",
        progressCode: ProgressCode.STEAMCMD_DOWNLOADING,
      });
      // windows-steamcmd-selfheal, 2026-09-10 (god-directed unification):
      // this branch used to inline its own download+extract+first-run
      // implementation -- now shares provisionSteamCmdWindows() +
      // runSteamCmdFirstTimeSetup() with ensureSteamCmdWindows (the Windows
      // auto-heal path used by /install and /steam-update), so there is
      // exactly one Windows download+extract+first-run implementation
      // instead of two independently drifting ones. This route's own
      // contract is unchanged: res.json() below still returns immediately,
      // real progress still travels over steamcmd:status/steamcmd:log.
      // provisionSteamCmdWindows() already emits its own error events and
      // does not touch steamcmdDownloadInProgress itself (this route's own
      // claim above owns that) -- released via .finally() the moment
      // download+extract settles, BEFORE first-time-setup starts, matching
      // the Linux branch below and the pre-unification timing (the guard
      // protects the shared zip-path write, not the whole provisioning
      // process). The trailing .catch() is this call site's own
      // unhandledRejection backstop (same reasoning the old
      // extractAndSetup() caller comment gave) -- runSteamCmdFirstTimeSetup
      // already emits its own error status/log on failure.
      provisionSteamCmdWindows(installPath, io)
        .finally(() => {
          steamcmdDownloadInProgress = false;
        })
        .then(() =>
          runSteamCmdFirstTimeSetup(
            getSteamCmdExe(installPath),
            installPath,
            io,
          ),
        )
        .catch((err) => {
          log.error(`SteamCMD download failed unexpectedly: ${err.message}`);
        });
    } else {
      // Linux: Download and extract tar.gz, then make executable
      const execCb = exec;
      const tarUrl =
        "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz";
      const tarPath = path.join(installPath, "steamcmd_linux.tar.gz");

      io.to("install").emit("steamcmd:status", {
        status: "downloading",
        message: "Downloading SteamCMD for Linux...",
        progressCode: ProgressCode.STEAMCMD_DOWNLOADING_LINUX,
      });
      log.info(`Downloading SteamCMD (Linux) to ${installPath}`);

      // Try curl first, fall back to wget (CentOS minimal may lack curl)
      const safeTarPath = tarPath.replace(/'/g, "'\\''");
      const safeTarUrl = tarUrl.replace(/'/g, "'\\''");
      const curlCmd = `curl -sSL -o '${safeTarPath}' '${safeTarUrl}'`;
      const wgetCmd = `wget -q -O '${safeTarPath}' '${safeTarUrl}'`;

      const tryDownload = (cmd, fallbackCmd) => {
        execCb(cmd, { timeout: 120000 }, (dlErr) => {
          if (dlErr && fallbackCmd) {
            log.warn(
              `Download with ${cmd.split(" ")[0]} failed, trying fallback...`,
            );
            tryDownload(fallbackCmd, null);
            return;
          }
          if (dlErr) {
            steamcmdDownloadInProgress = false;
            io.to("install").emit("steamcmd:status", {
              status: "error",
              message: `Download failed: ${dlErr.message}. Ensure curl or wget is installed.`,
              progressCode: ProgressCode.STEAMCMD_DOWNLOAD_FAILED_LINUX,
              params: { reason: dlErr.message },
            });
            log.error(`SteamCMD download failed: ${dlErr.message}`);
            return;
          }
          afterDownload();
        });
      };

      tryDownload(curlCmd, wgetCmd);

      function afterDownload() {
        io.to("install").emit("steamcmd:status", {
          status: "extracting",
          message: "Extracting SteamCMD...",
          progressCode: ProgressCode.STEAMCMD_EXTRACTING,
        });
        log.info("Extracting SteamCMD...");

        const safeInstallPath = installPath.replace(/'/g, "'\\''");
        execCb(
          `tar -xzf '${safeTarPath}' -C '${safeInstallPath}'`,
          { timeout: 30000 },
          (tarErr) => {
            // Clean up tar file regardless
            try {
              fs.unlinkSync(tarPath);
            } catch (e) {
              /* ignore */
            }
            // Either way, this attempt is done writing to tarPath now --
            // safe for a new download to reuse it.
            steamcmdDownloadInProgress = false;

            if (tarErr) {
              io.to("install").emit("steamcmd:status", {
                status: "error",
                message: `Extraction failed: ${tarErr.message}`,
                progressCode: ProgressCode.STEAMCMD_EXTRACTION_FAILED,
                params: { reason: tarErr.message },
              });
              log.error(`SteamCMD extraction failed: ${tarErr.message}`);
              return;
            }

            // Make steamcmd.sh executable
            const steamcmdSh = path.join(installPath, "steamcmd.sh");
            try {
              fs.chmodSync(steamcmdSh, 0o755);
            } catch (e) {
              /* ignore */
            }
            // Also make the actual binary executable
            const steamcmdBin = path.join(installPath, "steamcmd");
            try {
              fs.chmodSync(steamcmdBin, 0o755);
            } catch (e) {
              /* ignore */
            }

            // Install 32-bit libraries if missing (SteamCMD requires them on 64-bit CentOS/RHEL)
            log.info(
              "Checking for required 32-bit libraries (SteamCMD dependency)...",
            );
            execCb(
              "ldconfig -p | grep -c libc.so.6",
              { timeout: 5000 },
              (ldErr) => {
                if (ldErr) {
                  log.warn(
                    "Could not verify 32-bit libraries. SteamCMD may fail if glibc.i686 / lib32gcc is not installed.",
                  );
                  // Our own authored text, not SteamCMD's -- deliberately
                  // NOT routed through emitRawSteamCmdLine(). It carries a
                  // progressCode like every other authored line, on the
                  // same event a raw line would use, which is exactly the
                  // ambiguity that made this call site worth fixing: with
                  // the helper split in place, a raw line physically
                  // cannot carry a progressCode, so this one being
                  // authored is now visible in the payload shape itself.
                  io.to("install").emit("steamcmd:log", {
                    type: "stderr",
                    text: "Warning: Could not verify 32-bit libraries. If SteamCMD fails, install: yum install glibc.i686 libstdc++.i686 (CentOS/RHEL) or apt install lib32gcc-s1 (Debian/Ubuntu)",
                    progressCode: ProgressCode.STEAMCMD_32BIT_LIB_WARNING,
                  });
                }
                // steamcmdDownloadInProgress was already released above,
                // right after tar extraction -- this call, like the
                // Windows branch's own equivalent, is fire-and-forget from
                // this route's perspective; runSteamCmdFirstTimeSetup()
                // already emits its own status/log on both success and
                // failure, this .catch() is only the unhandledRejection
                // backstop (windows-steamcmd-selfheal, 2026-09-10 --
                // unified with ensureSteamCmdLinux/ensureSteamCmdWindows's
                // shared first-run implementation, see that function's own
                // header comment).
                runSteamCmdFirstTimeSetup(
                  getSteamCmdExe(installPath),
                  installPath,
                  io,
                ).catch((err) => {
                  log.error(
                    `SteamCMD first-run failed unexpectedly: ${err.message}`,
                  );
                });
              },
            );
          },
        );
      }
    }

    res.json({ success: true, message: "SteamCMD download started" });
  } catch (error) {
    // Reached only by a failure in this handler's own synchronous setup
    // (getSetting/setSetting/mkdirSync above) -- the background
    // download/extract/first-run never throws back into this try block (see
    // provisionSteamCmdWindows/runSteamCmdFirstTimeSetup's own release
    // points above), so this is the one guard-release site outside the
    // platform-specific paths.
    steamcmdDownloadInProgress = false;
    log.error(`SteamCMD download failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Check if SteamCMD exists at a path
router.get("/steamcmd/check", requirePermission("server.install"), async (req, res) => {
  try {
    const { path: checkPath } = req.query;

    if (!checkPath || !isValidPath(checkPath)) {
      return res.json({ exists: false, message: "Invalid path" });
    }

    const steamcmdExe = getSteamCmdExe(checkPath);
    const exists = fs.existsSync(steamcmdExe);

    res.json({
      exists,
      path: checkPath,
      executable: steamcmdExe,
      message: exists
        ? "SteamCMD found"
        : "SteamCMD not found at this location",
    });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Fail-closed "is THIS SPECIFIC configured server confirmed stopped" check.
//
// split-derivation sweep, 2026-09-07 (same class as /wipe's pre-fix bug,
// 5c2e73e9): the original version of this check took a `serverManager`
// instance and trusted ITS cached running-state -- but `serverManager` is a
// single global instance (server/index.js's one `new ServerManager()`)
// that only ever reflects whichever server is currently active/loaded, not
// necessarily the server /delete-files is about to act on. /delete-files
// accepts ANY configured server's installPath (Servers.tsx's "Clear Install
// Folder"/"Delete Everything" can target a server that isn't active), so
// the old check answered "is the ACTIVE server stopped?" while the route
// deleted a DIFFERENT server's files entirely -- reachable without even a
// race, just by acting on a non-active server.
//
// state-detection lane, 2026-09-07 (round 2 -- the first fix above didn't
// go far enough): still used serverManager.getServerProcessDetails() --
// which is scoped to whichever server serverManager itself has loaded, NOT
// targetServer -- plus a bare, unbounded substring match on installPath.
// Concretely: Server A active+stopped, Server B configured+running with its
// own -servername; scoring B's real process against A's descriptor
// disqualifies it (-1), so it lands in neither owned nor unattributable and
// vanishes from `matched` entirely; this check then saw an empty list and
// confidently said "not running." Fixed the same way as servers.js's own
// GET /api/servers/status (611687a5): scan the whole host
// (ServerManager.scanHostForServerProcesses(), unfiltered by any one
// server's loadConfig()) and attribute via scoreServerProcessOwnership()
// against TARGET's own descriptor, on a throwaway instance -- never the
// shared `serverManager` singleton, whose cached isRunning means something
// different ("MY loaded server") than a host-wide answer would.
//
// A THIRD outcome now matters that didn't for the read-only /status list:
// scoreServerProcessOwnership() can return 0 ("unattributable" -- a real
// PZ-server-shaped process with no -servername/-cachedir, whose install
// path doesn't match this target either) for a candidate that might still
// BE this target, launched via a stock script with no identifying args, in
// a shape this scan just couldn't pin down. /status can afford to render
// that as "stopped" (a wrong badge is cosmetic); this check guards a
// recursive fs.rmSync against a live install, so "cannot confirm it isn't
// this one" must refuse exactly like a failed scan does, not read as "safe
// to delete." Only zero owned AND zero unattributable candidates counts as
// confirmed stopped.
// `options.scan`: a host process scan to reuse (see checkGameFolderServersStopped),
// a promise or a result; a fresh scan is made when it is absent.
export async function checkSpecificServerStopped(targetServer, actionLabel, options = {}) {
  if (isManagedLifecycleProvider(targetServer.lifecycleProvider)) {
    try {
      const status = await createLinuxServiceLifecycle(
        targetServer,
        targetServer.lifecycleProvider,
      ).status();
      if (status.scanFailed) {
        return {
          status: 503,
          body: {
            error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
            code: ErrorCode.SERVER_STATE_UNKNOWN,
          },
        };
      }
      if (status.running) {
        return {
          status: 400,
          body: {
            error: `Server must be stopped before ${actionLabel}. Stop the server first.`,
            code: ErrorCode.WIPE_SERVER_RUNNING,
          },
        };
      }
      return null;
    } catch (error) {
      return {
        status: 503,
        body: {
          error: `Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server (${error.message}).`,
          code: ErrorCode.SERVER_STATE_UNKNOWN,
        },
      };
    }
  }

  let scan;
  try {
    scan = await (options.scan ?? new ServerManager().scanHostForServerProcesses());
  } catch (error) {
    return {
      status: 503,
      body: {
        error: `Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server (${error.message}).`,
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      },
    };
  }
  if (scan.scanFailed) {
    return {
      status: 503,
      body: {
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      },
    };
  }

  const descriptor = {
    serverName: targetServer.serverName,
    savePath: targetServer.zomboidDataPath,
    serverPath: targetServer.serverPath || targetServer.installPath,
  };
  const matched = Array.isArray(scan.matched) ? scan.matched : [];
  let owned = false;
  let unattributable = false;
  for (const m of matched) {
    const score = scoreServerProcessOwnership(m.cmd, descriptor);
    if (score > 0) owned = true;
    else if (score === 0) unattributable = true;
  }

  if (owned) {
    return {
      status: 400,
      body: {
        error: `Server must be stopped before ${actionLabel}. Stop the server first.`,
        // Shared with /wipe -- see errorCodes.js for why.
        code: ErrorCode.WIPE_SERVER_RUNNING,
      },
    };
  }
  if (unattributable) {
    return {
      status: 503,
      body: {
        error: "Can't verify whether the server is actually stopped — a dedicated PZ server process exists on this host that can't be confirmed to belong to a different server. Check the panel's log for the process, or stop it and try again.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      },
    };
  }
  // Windows only: processes listed without a command line the panel may
  // read. None of the readable ones is this target, but one of those may
  // be -- see scanLeavesServerUnknown().
  if (scanLeavesServerUnknown(scan, false)) {
    return {
      status: 503,
      body: {
        error: "Can't verify whether the server is actually stopped — Windows lists a Java or Project Zomboid process the panel isn't allowed to read (usually one started as administrator or by another Windows user), and it could be this server. Check the panel's log for its PID, or stop it and try again.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      },
    };
  }
  return null;
}

// Builds the `targetServer` checkSpecificServerStopped() needs for a route
// that has no `servers`-table row to hand it directly -- /install,
// /quick-setup and /steam-update all accept an arbitrary installPath from
// req.body with zero binding to any configured server (confirmed: none of
// the three calls addServer() or references a serverId; server rows with
// their own installPath field are created by a wholly separate route in
// routes/servers.js).
//
// 2026-09-08, steamcmd-routes-running-check card: all three used to answer
// "is the server running" by checking whichever server the shared
// `serverManager` singleton happens to have loaded (or, for /install and
// /quick-setup, not checking at all) -- Convention A, correct only when the
// caller already guarantees serverManager points at the request's own
// installPath, which none of them did. Same wrong-target shape as
// checkSpecificServerStopped() itself before this file's own 8f04b051 fix.
//
// If installPath happens to match an ALREADY-CONFIGURED server (the common
// case: re-running steam-update, or quick-setup, against a server the
// operator already registered), prefer that real row -- it carries the
// authoritative lifecycleProvider (routing a systemd/openrc-managed server
// through its own service-status check, not a raw process scan) and its own
// real serverName/zomboidDataPath, both more trustworthy than whatever the
// client happened to submit this request. Falls back to a synthetic
// descriptor built from the request's own fields only when genuinely no
// configured server matches -- a brand-new install this panel has never
// registered, exactly the state /install's own first-time-setup case is in.
//
// Shared game folders: Quick Setup reuses the active server's install folder
// on purpose, so SEVERAL profiles can use one folder. Returns the target
// (the exact-path match, else any profile using the folder, else the
// synthetic descriptor) and every profile using the folder; callers check
// all of them with checkGameFolderServersStopped(). Checking only the first
// profile with that path let a stopped profile's Delete files / Clear
// install folder / Update wipe or patch the files of a running one.
async function resolveTargetServerForRunningCheck(installPath, fallback = {}) {
  const resolvedPath = path.resolve(installPath);
  const sharing = await serversUsingGameFolder(installPath);
  const matchedServer =
    sharing.find((s) => s.installPath && path.resolve(s.installPath) === resolvedPath) ||
    sharing[0];
  const target = matchedServer || {
    serverName: fallback.serverName,
    zomboidDataPath: fallback.zomboidDataPath,
    installPath,
  };
  return { target, sharing };
}

// Every local profile whose game folder is `installPath`: the same real
// folder however it is spelled (case on Windows, a trailing separator, a
// junction or symlink -- installDirKey()), with a launcher-file installPath
// standing for its folder (resolveInstallDir()). A remote (SFTP) profile's
// path names a folder on another host and never shares this one.
async function serversUsingGameFolder(installPath) {
  const key = installDirKey(installPath);
  if (!key) return [];
  const configuredServers = (await getServers()) || [];
  return configuredServers.filter((server) => {
    if (!server || isUnmanagedRemoteServer(server)) return false;
    const folders = [
      resolveInstallDir(server),
      resolveInstallDir({ installPath: server.installPath }),
    ];
    return folders.some((folder) => folder && installDirKey(folder) === key);
  });
}

// checkSpecificServerStopped() for every profile using one game folder,
// the target first (its own refusal keeps its wording). Another profile
// found running is named with its own code, so the operator knows which
// server to stop: the one they acted on may well be stopped.
async function checkGameFolderServersStopped(target, sharing, actionLabel) {
  const others = sharing.filter((server) => server !== target);
  // One host process scan for all of them (on Windows each scan starts
  // PowerShell, about 0.5-2 s), made only if a profile needs it; profiles run
  // by a lifecycle provider (systemd/OpenRC) ask that provider instead.
  let sharedScan = null;
  const scanOnce = () => {
    if (!sharedScan) sharedScan = new ServerManager().scanHostForServerProcesses();
    return sharedScan;
  };
  for (const server of [target, ...others]) {
    const scan = isManagedLifecycleProvider(server.lifecycleProvider) ? undefined : scanOnce();
    const notStoppedError = await checkSpecificServerStopped(server, actionLabel, { scan });
    if (!notStoppedError) continue;
    if (server !== target && notStoppedError.body?.code === ErrorCode.WIPE_SERVER_RUNNING) {
      const name = String(server.name || server.serverName || "another server");
      return {
        status: 409,
        body: {
          error: `"${name}" uses the same game folder and is running. Stop it before ${actionLabel}.`,
          code: ErrorCode.INSTALL_FOLDER_SHARED_SERVER_RUNNING,
          params: { name },
        },
      };
    }
    return notStoppedError;
  }
  return null;
}

// Delete server files (used when removing a server from panel with file deletion)
router.post("/delete-files", requirePermission("server.wipe"), async (req, res) => {
  // lifecycle-lock-set sweep, 2026-09-07: checkSpecificServerStopped()
  // above already narrows the check-then-delete TOCTOU window "as far as
  // it can go without a shared lock with /start, which is out of scope
  // here" (dd1e44f1's own comment) -- that scoping was correct then
  // (a different lane, single-source derivation only), it's this lane's
  // question now. The actual rmSync() below is synchronous and runs
  // immediately after the check, so the only exposed window is the
  // checked round-trip itself, but a /start landing in exactly that
  // window still launches the JVM against files about to be deleted out
  // from under it. Same fix as /wipe (bfc0e515) and now chunks.js's
  // delete-chunks/delete-region: take the process-wide lifecycleCoordinator
  // lock for the whole handler. Acquired before deletePath is even parsed
  // (nothing here identifies a target server yet), so no serverId is passed
  // -- degrades to the generic refusal wording, see
  // lifecycleCoordinator.js's own comment on that fallback.
  //
  // normalize-lifecycle-lock-server-identifier, 2026-09-08: deliberately
  // still null, not a gap left over from that sweep. targetServer (the
  // actual server DB id) isn't resolved until deep in the try block below
  // -- after confirm/path/existence/PZ-marker checks -- by matching
  // deletePath against configured servers' installPath. Fetching that
  // early enough to pass into the lock would mean either doing the DB
  // lookup before the lock (an async gap the TOCTOU fix above exists
  // specifically to close) or acquiring the lock after it (reopening the
  // exact race this fix closes). Nothing here is a server DB id yet at the
  // one point in this handler an id could be attached to the lock -- a
  // genuine "no id available" site, not an oversight.
  const lifecycleLock = acquireLifecycleLock("delete-files");
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    const { path: deletePath, confirm, confirmShared } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({
        error: "Deleting these files requires confirm: true",
        // Own code, not /wipe's -- see errorCodes.js for why this was split
        // from the shared WIPE_CONFIRM_REQUIRED (2026-08-26 bug hunt round 2).
        code: ErrorCode.DELETE_FILES_CONFIRM_REQUIRED,
      });
    }

    if (!deletePath || !isValidPath(deletePath)) {
      return res.status(400).json({ error: "Invalid path", code: ErrorCode.INVALID_PATH });
    }

    // Safety check: path must exist and contain PZ server files
    if (!fs.existsSync(deletePath)) {
      return res.status(404).json({ error: "Path does not exist", code: ErrorCode.PATH_NOT_FOUND });
    }

    // Check for known PZ server markers to prevent accidental deletion of wrong folders
    // Require one of the PZ-specific files (not just generic dirs like 'java')
    const hasPzFiles = hasPzInstallMarker(deletePath);

    // Also reject paths containing '..' after normalization
    const normalizedDelete = path.normalize(deletePath);
    if (normalizedDelete.includes("..")) {
      return res.status(400).json({ error: "Invalid path", code: ErrorCode.INVALID_PATH });
    }

    if (!hasPzFiles) {
      return res.status(400).json({
        error:
          "This does not appear to be a Project Zomboid server installation. Refusing to delete for safety.",
        code: ErrorCode.DELETE_FILES_NOT_PZ_INSTALL,
      });
    }

    // hasPzInstallMarker() above only confirms a handful of marker
    // FILENAMES exist -- trivially satisfied by creating an empty file
    // with one of those names anywhere on the host, not an authorization
    // check (bug-hunt-2026-08-27). The two real callers of this route
    // (Servers.tsx's "Delete Everything" and "Clear Install Folder") only
    // ever pass a path that's already a configured server's own
    // installPath, so require an exact match against one -- turning
    // "any directory with a spoofable marker file" into "must be a server
    // the panel already has on record" (creating that record requires
    // servers.manage, a capability distinct from server.wipe). This is a
    // second, narrower layer on top of the marker check, not a
    // replacement for it.
    const resolvedDeletePath = path.resolve(deletePath);
    const configuredServers = await getServers();
    // .find(), not .some() -- the matched record's own zomboidDataPath and
    // lifecycleProvider are needed below for the nesting and stopped
    // checks, not just a yes/no membership test.
    const targetServer = configuredServers.find(
      (s) => s.installPath && path.resolve(s.installPath) === resolvedDeletePath,
    );
    if (!targetServer) {
      return res.status(400).json({
        error:
          "This path doesn't match a server the panel has on record. Refusing to delete for safety.",
        code: ErrorCode.DELETE_FILES_NOT_CONFIGURED_SERVER,
      });
    }

    // steamcmd-routes-running-check card, second finding: this route does a
    // RECURSIVE rmSync directly on installPath, unconditionally, with no
    // check for an in-progress SteamCMD operation at all -- so the panel
    // could delete an install directory while its own SteamCMD process (see
    // POST /install, POST /steam-update) is actively writing into that exact
    // path. Unlike /wipe's version of this same gap (conditional on
    // zomboidDataPath nesting inside installPath), this one is unconditional:
    // deletePath IS installPath. Same guard /install and /steam-update
    // already claim before spawning, reused here rather than introducing a
    // lock -- activeSteamOperations is already scoped per install path,
    // exactly what this check needs.
    const normalizedDeleteTargetPath = path
      .normalize(deletePath)
      .toLowerCase();
    if (hasActiveSteamOperation(normalizedDeleteTargetPath)) {
      return res.status(409).json({
        error:
          "A Steam operation is already in progress for this path. Please wait for it to complete.",
        code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_PATH,
      });
    }

    // A default install keeps the Zomboid data folder OUTSIDE installPath
    // (resolveZomboidPaths defaults it to a sibling `<installPath>_Data`),
    // so deleting the install folder alone leaves Saves/Multiplayer
    // untouched -- annoying (reinstall via the Setup Wizard) but not a
    // world-ending loss. Nothing stops an operator from pointing
    // zomboidDataPath INSIDE the install folder instead, though, and
    // nothing here ever checked for it. When that's the configuration,
    // this delete also destroys the live world save -- a different
    // severity than "reinstall the binaries," and the UI gives no
    // indication either way. Refuse outright rather than trying to back
    // the data up first: the backups folder itself lives at
    // <zomboidDataPath>/backups, which would be inside the doomed tree
    // too, so a same-tree backup would just get deleted right alongside
    // everything else it was meant to protect.
    //
    // targetServer.zomboidDataPath, not serverManager.savePath -- same
    // split-derivation fix as the stopped-check below: serverManager's
    // cache reflects whichever server is currently active/loaded, which is
    // not necessarily targetServer.
    const zomboidDataPath = targetServer.zomboidDataPath;
    if (zomboidDataPath) {
      if (confineToRoots(zomboidDataPath, [resolvedDeletePath])) {
        return res.status(400).json({
          error: `Refusing to delete: this server's Zomboid data folder (${zomboidDataPath}) is inside the folder you're about to delete, so this would also permanently destroy the world save. Move the data path outside the install folder in Settings, or back it up yourself first, before deleting.`,
          code: ErrorCode.DELETE_FILES_DATA_PATH_NESTED,
        });
      }
    }

    // Other profiles using this same game folder (Quick Setup reuses the
    // active server's install on purpose). This route used to look at the
    // first profile with the path only, so deleting a stopped profile's
    // files wiped a running one that shares them. Their world saves get the
    // same nesting refusal as the target's; the folder itself goes only
    // when the caller confirmed it knows the others lose their game files
    // too (the client lists them before sending confirmShared), and only
    // once every one of them is stopped (below).
    const otherServersUsingFolder = (await serversUsingGameFolder(deletePath)).filter(
      (server) => String(server.id) !== String(targetServer.id),
    );
    for (const server of otherServersUsingFolder) {
      if (server.zomboidDataPath && confineToRoots(server.zomboidDataPath, [resolvedDeletePath])) {
        return res.status(400).json({
          error: `Refusing to delete: the Zomboid data folder of "${server.name || server.serverName}" (${server.zomboidDataPath}), which uses the same game folder, is inside the folder you're about to delete, so this would also permanently destroy its world save.`,
          code: ErrorCode.DELETE_FILES_DATA_PATH_NESTED,
        });
      }
    }
    if (otherServersUsingFolder.length > 0 && confirmShared !== true) {
      const names = otherServersUsingFolder
        .map((server) => String(server.name || server.serverName || server.id))
        .join(", ");
      return res.status(409).json({
        error: `This game folder is also used by ${names}. Deleting it removes their game files too. Confirm to delete it anyway.`,
        code: ErrorCode.DELETE_FILES_FOLDER_SHARED,
        params: { names },
        sharedWith: otherServersUsingFolder.map((server) => ({
          id: server.id,
          name: server.name || server.serverName || null,
        })),
      });
    }

    // Confirmed-stopped check, positioned immediately before the
    // irreversible delete (2026-08-26 bug hunt round 2, Pam's finding 2:
    // narrows the check-then-act TOCTOU window as far as it can go without
    // a shared lock with /start, which is out of scope here) -- now against
    // targetServer specifically rather than serverManager's cache. This
    // used to run TWICE: once before deletePath was even parsed (checking
    // whatever server happened to be active/loaded, which is not the
    // server-identity question this route needs answered at all) and once
    // here. The first copy is gone -- it was answering the wrong question,
    // not just answering it from a stale source -- leaving this single,
    // correctly-targeted check right before the delete it guards. Every
    // profile using the folder must be stopped, not only targetServer.
    const notStoppedError = await checkGameFolderServersStopped(
      targetServer,
      [targetServer, ...otherServersUsingFolder],
      "deleting its files",
    );
    if (notStoppedError) {
      return res.status(notStoppedError.status).json(notStoppedError.body);
    }

    log.warn(`Deleting server files at: ${deletePath}`);

    // Use recursive delete
    fs.rmSync(deletePath, { recursive: true, force: true });

    log.info(`Successfully deleted server files at: ${deletePath}`);
    res.json({ success: true, message: "Server files deleted" });
  } catch (error) {
    log.error(`Failed to delete server files: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    lifecycleLock.release();
  }
});

// List directory contents for the in-app folder browser
router.post("/list-directory", requirePermission("server.install"), async (req, res) => {
  try {
    const { dirPath } = req.body || {};

    // If no path provided, return available drives (Windows) or root (Linux)
    if (!dirPath) {
      if (isWindows) {
        // List available drive letters
        const drives = [];
        for (let i = 65; i <= 90; i++) {
          const letter = String.fromCharCode(i);
          const drivePath = `${letter}:\\`;
          try {
            fs.accessSync(drivePath, fs.constants.R_OK);
            let label = `Local Disk (${letter}:)`;
            try {
              const stats = fs.statfsSync(drivePath);
              const totalGB = (
                (stats.bsize * stats.blocks) /
                1024 ** 3
              ).toFixed(1);
              const freeGB = ((stats.bsize * stats.bfree) / 1024 ** 3).toFixed(
                1,
              );
              label = `${letter}: — ${freeGB} GB free of ${totalGB} GB`;
            } catch (e) {
              log.debug(`Drive stat failed for ${letter}: ${e.message}`);
            }
            drives.push({
              name: `${letter}:`,
              path: drivePath,
              label,
              isDrive: true,
            });
          } catch (e) {
            // Drive not accessible
          }
        }
        return res.json({
          entries: drives,
          currentPath: null,
          parentPath: null,
        });
      } else {
        // Linux: start at root
        return res.json({
          entries: [{ name: "/", path: "/", label: "/", isDrive: true }],
          currentPath: null,
          parentPath: null,
        });
      }
    }

    // Validate the requested path
    if (!isValidPath(dirPath)) {
      return res.status(400).json({ error: "Invalid path", code: ErrorCode.INVALID_PATH });
    }

    const normalized = path.normalize(dirPath);

    if (!fs.existsSync(normalized)) {
      return res.status(404).json({ error: "Path does not exist", code: ErrorCode.PATH_NOT_FOUND });
    }

    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Path is not a directory", code: ErrorCode.PATH_NOT_A_DIRECTORY });
    }

    // Read directory entries — only folders
    let items;
    try {
      items = fs.readdirSync(normalized, { withFileTypes: true });
    } catch (e) {
      const osCode = e && typeof e === "object" && "code" in e ? e.code : "UNKNOWN";
      const readError = formatDirectoryReadError(normalized, osCode);
      return res.status(403).json({
        error: readError.message,
        code: readError.code,
        params: readError.params,
      });
    }

    const folders = [];
    for (const item of items) {
      if (!item.isDirectory()) continue;
      // Skip hidden/system folders
      if (
        item.name.startsWith(".") ||
        item.name === "$RECYCLE.BIN" ||
        item.name === "System Volume Information"
      )
        continue;
      folders.push({
        name: item.name,
        path: path.join(normalized, item.name),
      });
    }

    // Sort alphabetically, case-insensitive
    folders.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    // Parent path
    const parentPath = path.dirname(normalized);
    const hasParent = parentPath !== normalized; // at root when dirname === self

    res.json({
      entries: folders,
      currentPath: normalized,
      parentPath: hasParent ? parentPath : null,
    });
  } catch (error) {
    log.error(`List directory failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Open folder browser dialog (uses PowerShell on Windows, zenity/kdialog on Linux)
router.post("/browse-folder", requirePermission("server.install"), async (req, res) => {
  try {
    const { initialPath, description = "Select a folder" } = req.body || {};

    // Strict validation for description — alphanumeric, spaces, and basic punctuation only
    if (
      typeof description !== "string" ||
      description.length > 100 ||
      !/^[a-zA-Z0-9 _.\-:()]+$/.test(description)
    ) {
      return res.status(400).json({ error: "Invalid description parameter", code: ErrorCode.BROWSE_FOLDER_INVALID_DESCRIPTION });
    }

    // Defense-in-depth: a folder to open the picker at hardly ever contains
    // a control character, a quote, a backtick or `$` (`$` only in an admin
    // share like \\host\C$ or a hidden system folder, which then can't be
    // the starting folder). The value is handed to the OS
    // picker out-of-band (an environment variable on Windows, a
    // single-quoted argv on Linux) and never built into shell/PowerShell
    // source, so this is a second line, not the primary guard -- but
    // refusing it outright keeps a crafted value from ever reaching the
    // interpreter at all. The typographic single-quote family U+2018-U+201B
    // is included because PowerShell's parser treats those like an ASCII '.
    if (
      typeof initialPath === "string" &&
      /[\u0000-\u001f\u007f'`$\u2018-\u201b]/.test(initialPath)
    ) {
      return res.status(400).json({
        error: "Invalid initial path parameter",
        code: ErrorCode.BROWSE_FOLDER_INVALID_PATH,
      });
    }

    if (!isWindows) {
      // Linux: try zenity, then kdialog, then return unsupported
      const execCb = exec;
      const safeDesc = description.replace(/'/g, "'\\''");
      const safePath =
        initialPath && isValidPath(initialPath)
          ? initialPath.replace(/'/g, "'\\''")
          : "";

      // Try zenity first (GNOME/GTK)
      const zenityCmd = `zenity --file-selection --directory --title='${safeDesc}'${safePath ? ` --filename='${safePath}/'` : ""}`;
      execCb(zenityCmd, { timeout: 120000 }, (zenErr, zenOut) => {
        if (!zenErr && zenOut && zenOut.trim()) {
          return res.json({
            success: true,
            path: zenOut.trim(),
            cancelled: false,
          });
        }
        // If zenity returned exit code 1 (user cancelled), return cancelled
        if (zenErr && zenErr.code === 1) {
          return res.json({ success: false, path: null, cancelled: true });
        }
        // Try kdialog (KDE)
        const kdialogCmd = `kdialog --getexistingdirectory '${safePath || "~"}' --title '${safeDesc}'`;
        execCb(kdialogCmd, { timeout: 120000 }, (kdErr, kdOut) => {
          if (!kdErr && kdOut && kdOut.trim()) {
            return res.json({
              success: true,
              path: kdOut.trim(),
              cancelled: false,
            });
          }
          if (kdErr && kdErr.code === 1) {
            return res.json({ success: false, path: null, cancelled: true });
          }
          // No GUI dialog available
          return res.status(501).json({
            error:
              "No folder browser available. Install zenity or kdialog, or enter the path manually.",
            code: ErrorCode.BROWSE_FOLDER_NO_DIALOG_AVAILABLE,
          });
        });
      });
      return;
    }

    // The initial folder and the dialog title are passed to PowerShell
    // OUT-OF-BAND, as environment variables, instead of being interpolated
    // into the -Command source. The script reads them only as $env:... data,
    // so nothing in `initialPath`/`description` is ever parsed as PowerShell
    // -- this is the real fix (the character check above is only
    // defense-in-depth). Same pattern as utils/browserCookies.js
    // ($env:ZCP_SRC/ZCP_DST). -LiteralPath keeps Test-Path from treating the
    // value as a wildcard, and an empty/undefined env var is falsy in the
    // `-and` guard so no SelectedPath is set when there is no initial path.
    const safePath =
      initialPath && isValidPath(initialPath) ? initialPath : "";

    // Simple FolderBrowserDialog — needs -STA for COM, no RootFolder restriction
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:ZCP_FOLDER_DIALOG_DESC
$dialog.UseDescriptionForTitle = $true
$dialog.ShowNewFolderButton = $true
if ($env:ZCP_INITIAL_PATH -and (Test-Path -LiteralPath $env:ZCP_INITIAL_PATH)) { $dialog.SelectedPath = $env:ZCP_INITIAL_PATH }
$result = $dialog.ShowDialog()
if ($result -eq 'OK') { Write-Output $dialog.SelectedPath } else { Write-Output '' }
`;

    const powershell = spawn(
      "powershell",
      ["-NoProfile", "-STA", "-Command", psScript],
      {
        windowsHide: false,
        env: {
          ...process.env,
          ZCP_INITIAL_PATH: safePath,
          ZCP_FOLDER_DIALOG_DESC: description,
        },
      },
    );

    let output = "";
    let errorOutput = "";
    let settled = false;
    // platform-divergence-sweep (2026-09-10): the Linux branch above bounds
    // both zenity and kdialog with { timeout: 120000 } -- this branch had no
    // ceiling at all, and index.js only bounds how long a request takes to
    // arrive, never how long its answer takes, so a
    // FolderBrowserDialog left open (lost focus behind
    // another window, a known WinForms/STA quirk, or the operator just
    // walked away) hung the request indefinitely. 120000 matches the Linux
    // branch's own already-considered value rather than inventing a new one.
    const timeoutId = setTimeout(() => {
      log.warn("Folder browser dialog timed out after 120000ms; killing it");
      powershell.kill();
    }, 120000);

    powershell.stdout.on("data", (data) => {
      output += data.toString();
    });

    powershell.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    powershell.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      const selectedPath = output.trim();

      // A real Cancel click still exits 0 (`$result -eq 'OK'` is false, but
      // the script still reaches `Write-Output ''` and returns normally),
      // and our own timeout-kill above closes with code:null (Node reports
      // a signal-killed child that way, not a numeric exit code) -- both are
      // an ordinary "nothing was picked", same shape as Linux's own
      // cancelled case. A genuine non-zero exit only happens when the
      // SCRIPT ITSELF failed (no interactive desktop session for the STA
      // COM dialog, a missing assembly, ...) -- that must not collapse into
      // "cancelled", or the operator sees a silently-closed dialog instead
      // of the real reason nothing came back.
      if (code !== 0 && code !== null) {
        log.error(
          `Folder browser dialog script failed (exit ${code}): ${errorOutput}`,
        );
        return res.status(500).json({
          error: "Failed to open folder browser",
          code: ErrorCode.BROWSE_FOLDER_OPEN_FAILED,
        });
      }

      if (errorOutput) {
        log.warn(`Folder browser had issues: ${errorOutput}`);
      }

      res.json({
        success: !!selectedPath,
        path: selectedPath || null,
        cancelled: !selectedPath,
      });
    });

    powershell.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      log.error(`Folder browser error: ${error.message}`);
      res.status(500).json({ error: "Failed to open folder browser", code: ErrorCode.BROWSE_FOLDER_OPEN_FAILED });
    });
  } catch (error) {
    log.error(`Browse folder failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ============================================
// Server Console Log (server-console.txt)
// ============================================

// Filter patterns for console log - patterns to exclude (noise)
const CONSOLE_LOG_EXCLUDE_PATTERNS = [
  // Duplicate sprites/textures (very spammy)
  /IsoSpriteManager\.AddSprite > duplicate texture/,
  // PlayerHitZombie packet spam (not consistent packets)
  /The packet PlayerHitZombie is not consistent/,
  // Missing icons for build items (cosmetic only)
  /XuiSkin\$EntityUiStyle\.Load > Could not find icon:/,
  /XuiSkin\$EntityUiStyle\.LoadComponentInfo> Could not find icon:/,
  // Recursive require warnings (usually harmless)
  /LuaManager\.RunLua > recursive require\(\)/,
  // AnimalPacket/AnimalEventPacket class warnings (known issue)
  /The AnimalPacket class doesn't have PacketSetting attributes/,
  /The AnimalEventPacket class doesn't have PacketSetting attributes/,
];

// Patterns for errors (always show these)
const CONSOLE_LOG_ERROR_PATTERNS = [
  /^ERROR\[/,
  /Exception thrown/,
  /Stack trace:/,
  /java\.lang\.\w+Exception/,
  /KahluaThread\.flushErrorMessage/,
];

// Patterns for important info (always show these)
const CONSOLE_LOG_IMPORTANT_PATTERNS = [
  /^\[PanelBridge\]/,
  /SERVER STARTED/,
  /fully-connected/,
  /player-connect/,
  /connection-lost/,
  /disconnect/,
  // Was /Steam client .* is initiating/, which rescanned the rest of the line
  // from every "Steam client " in it: a mod can print a 5 MB line of those,
  // and the Console page filters every line on each load.
  {
    test(line) {
      const at = line.indexOf("Steam client ");
      return at !== -1 && line.indexOf(" is initiating", at + "Steam client ".length) !== -1;
    },
  },
  /RCON:/,
  /Recipe AutoLearned/,
  /Reduce Head Condition/,
  /ISBuildIsoEntity/,
];

/**
 * Filter console log lines based on filter level
 * @param {string[]} lines - Array of log lines
 * @param {string} filterLevel - 'all' | 'filtered' | 'important' | 'errors'
 * @returns {string[]} Filtered lines
 */
function filterConsoleLogLines(lines, filterLevel = "filtered") {
  if (filterLevel === "all") {
    return lines;
  }

  return lines.filter((line) => {
    if (!line.trim()) return false;

    // Always include error lines
    const isError = CONSOLE_LOG_ERROR_PATTERNS.some((pattern) =>
      pattern.test(line),
    );
    if (isError) return true;

    // Always include important lines
    const isImportant = CONSOLE_LOG_IMPORTANT_PATTERNS.some((pattern) =>
      pattern.test(line),
    );
    if (isImportant) return true;

    // For 'errors' level, only show errors
    if (filterLevel === "errors") {
      return isError;
    }

    // For 'important' level, show errors + important
    if (filterLevel === "important") {
      return isError || isImportant;
    }

    // For 'filtered' level (default), exclude noise patterns
    const isNoise = CONSOLE_LOG_EXCLUDE_PATTERNS.some((pattern) =>
      pattern.test(line),
    );
    return !isNoise;
  });
}

// SECURITY (2026-10-05, PATHS-1): a remote server's server-console.txt is
// on its own host. Its record's data folder names a path there, so no
// save-time check holds it (services/zomboidDataPath.js leaves remote
// records alone), yet the four console-log routes below read, polled and
// truncated <that folder>/server-console.txt on this computer: servers.manage
// could aim them at that file name in any folder here. The Console page
// already shows a remote server's log as unavailable; the routes now agree
// -- the readers report no file, and /clear refuses.
//
// SECURITY (2026-10-05, PATHS-1 verifier pass 2): a local record with no
// data folder of its own fell back to the legacy settings copy, which
// setActiveServer() had copied from whichever server was active before --
// a remote one's included, never judged -- and to the install folder, which
// servers.manage sets to any folder. So the routes read and truncated
// server-console.txt there. The folder they use, whichever it is, is now
// held to the data-folder rule (services/zomboidDataPath.js): refused, the
// readers report no file, as for a remote server, and /clear refuses with
// ZOMBOID_DATA_FOLDER_REFUSED. A real install folder never held the
// game's server-console.txt (the game writes it to its -cachedir).
//
// SECURITY (2026-10-05, PT3/PT4): the install folder came before the legacy
// data folder, so a local record with no data folder of its own was judged
// on its install folder -- which the rule refuses -- and /clear answered
// ZOMBOID_DATA_PATH_NOT_DATA_FOLDER about a data folder that wasn't set.
// The data folders come first now (the record's, then the legacy one), and
// one that is set and refused is that refusal. The install folders are only
// a fallback with no data folder set at all, and one that doesn't pass
// means just that: SERVER_DATA_PATH_NOT_CONFIGURED. Either way `refusal`
// goes out with the readers' empty answer, so the Console page says why
// there is no log, and /clear answers it.
//
// SECURITY (2026-10-05, PT4 verifier round 2): with no data folder set,
// that answer was SERVER_DATA_PATH_NOT_CONFIGURED, which the Console page
// shows as "Server data path not configured" -- not where to set it. It has
// its own code now, whose text names the My Servers page as every other
// refusal does.
//
// SECURITY (2026-10-05, W5-P3): but an install folder that wasn't there
// yet passed the rule (a data folder that doesn't exist yet is accepted:
// the game creates it), so the Console page showed "no log" and no reason,
// and with no install folder at all the routes answered
// SERVER_DATA_PATH_NOT_CONFIGURED. With no data folder set, the start
// script the panel writes passes the game no -cachedir, so the game writes
// its console log in its own default folder, not the install folder. The
// install folder is used only when it meets the rule and already holds the
// game's console log (a custom launcher can name it as the -cachedir);
// anything else is this answer.
const CONSOLE_LOG_NO_DATA_FOLDER = {
  error:
    "This server has no Zomboid data folder set, and the game writes its console log there. On the My Servers page, edit the server and set its Zomboid Data Path.",
  code: ErrorCode.SERVER_CONSOLE_LOG_NO_DATA_FOLDER,
};

async function resolveConsoleLogFolder(activeServer) {
  if (activeServer?.isRemote) return { folder: null, remote: true, refused: false, refusal: null };
  // server-console.txt is in zomboidDataPath (where Server/, Saves/, Logs/ are)
  const dataFolder = activeServer?.zomboidDataPath || (await getSetting("zomboidDataPath"));
  if (dataFolder) {
    if (zomboidDataFolderHolds(dataFolder)) {
      // PT2 (verifier round 1): a 1.4.5 Saves/Multiplayer data folder's log
      // can be in the Zomboid folder it sits in (gameLogFolderOf()).
      return { folder: gameLogFolderOf(dataFolder), remote: false, refused: false, refusal: null };
    }
    const refusal = zomboidDataFolderRefusal();
    // PT5: the Console page polls these routes every 2s, so warn once per
    // folder, then debug.
    logRefusalOnce(log, `Not reading the server console log in ${dataFolder}: ${describeRefusal(refusal)}`);
    return { folder: null, remote: false, refused: true, refusal };
  }
  const installFolder = activeServer?.installPath || (await getSetting("serverPath"));
  if (
    installFolder &&
    zomboidDataFolderHolds(installFolder) &&
    fs.existsSync(path.join(installFolder, CONSOLE_LOG_FILE_NAME))
  ) {
    return { folder: installFolder, remote: false, refused: false, refusal: null };
  }
  return { folder: null, remote: false, refused: true, refusal: CONSOLE_LOG_NO_DATA_FOLDER };
}

// SECURITY (2026-10-05, H4): the console routes below admit
// server.world_events, which the moderator role holds, and the game's
// console log is full of host folders (the JVM's user.home and cachedir,
// every mod's install folder, ...). A role that doesn't set the server's
// folders up (utils/hostPathView.js) gets the lines path-redacted and the
// log's file name instead of where it lives.
const CONSOLE_LOG_FILE_NAME = "server-console.txt";

// SECURITY (2026-10-20): every role, admins included, gets the game's
// "Command line admin password: <value>" line redacted
// (utils/gameLogSecrets.js); the Console page never needs to show it.
async function consoleLogView(req) {
  if (await canSeeHostPaths(req.user)) {
    return {
      lines: (lines) => lines.map((line) => redactGameLogSecrets(line)),
      path: (consoleLogPath) => consoleLogPath,
    };
  }
  return {
    lines: (lines) => lines.map((line) => (line ? sanitizeError(redactGameLogSecrets(line)) : line)),
    path: () => CONSOLE_LOG_FILE_NAME,
  };
}

// Get server console log content
router.get("/console-log", requirePermission("server.world_events"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    const consoleLogFolder = await resolveConsoleLogFolder(activeServer);
    if (consoleLogFolder.remote || consoleLogFolder.refused) {
      // PT3: a refused data folder says why (`refusal`: its code, and what
      // to set) instead of reading as a log that doesn't exist yet.
      return res.json({
        success: true,
        content: "",
        lines: [],
        exists: false,
        ...(consoleLogFolder.refusal ? { refusal: consoleLogFolder.refusal } : {}),
      });
    }
    const zomboidDataPath = consoleLogFolder.folder;

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Server data path not configured", code: ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED });
    }

    const consoleLogPath = path.join(zomboidDataPath, CONSOLE_LOG_FILE_NAME);
    const view = await consoleLogView(req);

    if (!fs.existsSync(consoleLogPath)) {
      return res.json({
        success: true,
        content: "",
        lines: [],
        exists: false,
        path: view.path(consoleLogPath),
      });
    }

    // Filter level: 'all' | 'filtered' | 'important' | 'errors'
    const filterLevel = req.query.filter || "filtered";

    // Read last N lines (default 500, max 2000)
    const maxLines = parseBoundedInteger(req.query.lines, 500, 1, 2000);

    // Read only the tail of the file to prevent DoS with large log files
    const stats = fs.statSync(consoleLogPath);
    // The page streams from `size` right after this, so this is the file its
    // offset belongs to: seed the identity record (the first stream poll of a
    // path used to count as "never seen" and re-read the whole log) and hand
    // the client the token to echo back.
    observeConsoleLogIdentity(consoleLogPath, stats);
    const MAX_READ_BYTES = 5 * 1024 * 1024; // 5MB cap
    let content;
    if (stats.size > MAX_READ_BYTES) {
      const fd = fs.openSync(consoleLogPath, "r");
      const readStart = stats.size - MAX_READ_BYTES;
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      try {
        fs.readSync(fd, buffer, 0, MAX_READ_BYTES, readStart);
      } finally {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* ignore */
        }
      }
      // Skip first partial line after seeking
      const raw = buffer.toString("utf-8");
      const firstNewline = raw.indexOf("\n");
      content = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    } else {
      content = fs.readFileSync(consoleLogPath, "utf-8");
    }
    const allLines = content.split("\n");

    // Apply filtering
    const filteredLines = filterConsoleLogLines(allLines, filterLevel);
    const lines = view.lines(filteredLines.slice(-maxLines));

    res.json({
      success: true,
      content: lines.join("\n"),
      lines,
      totalLines: allLines.length,
      filteredCount: filteredLines.length,
      filterLevel,
      exists: true,
      path: view.path(consoleLogPath),
      lastModified: stats.mtime.toISOString(),
      size: stats.size,
      identity: consoleLogIdentityToken(stats),
    });
  } catch (error) {
    log.error(`Failed to read server console log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// The Console page's "Download server-console.txt": the file the log tab
// tails, alone, without building the whole support bundle. Same permission,
// same folder rule (resolveConsoleLogFolder(): never a path from the
// request) and the same per-role view as GET /console-log, plus the support
// bundle's raw-log redaction (known panel secrets, RCON `adduser`
// passwords, tokens). Streamed line by line up to the size it had when the
// download began; past CONSOLE_LOG_DOWNLOAD_MAX_BYTES only the newest part.
const CONSOLE_LOG_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

// "server-console-My_Server-2026-10-25.txt": nothing from the name but
// letters, digits, dot, dash and underscore.
function consoleLogDownloadFileName(serverName, now = new Date()) {
  const safeName = String(serverName || "server")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 60) || "server";
  return `server-console-${safeName}-${now.toISOString().slice(0, 10)}.txt`;
}

function createLineMapStream(mapLine) {
  let carry = "";
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const pushLines = (stream, text) => {
    carry += text;
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) stream.push(`${mapLine(line)}\n`);
  };
  return new Transform({
    transform(chunk, _enc, callback) {
      pushLines(this, decoder.decode(chunk, { stream: true }));
      callback();
    },
    flush(callback) {
      pushLines(this, decoder.decode());
      if (carry) this.push(mapLine(carry));
      callback();
    },
  });
}

router.get("/console-log/download", requirePermission("server.world_events"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    const consoleLogFolder = await resolveConsoleLogFolder(activeServer);
    if (consoleLogFolder.refusal) {
      return res.status(409).json(consoleLogFolder.refusal);
    }
    const consoleLogPath = consoleLogFolder.folder
      ? path.join(consoleLogFolder.folder, CONSOLE_LOG_FILE_NAME)
      : null;
    let stats = null;
    try {
      stats = consoleLogPath ? await fs.promises.stat(consoleLogPath) : null;
    } catch {
      stats = null;
    }
    if (!stats?.isFile()) {
      return res.status(404).json({ error: "File not found", code: ErrorCode.FILE_NOT_FOUND });
    }

    // Loaded here, not at the top: routes/debug.js imports routes/mods.js,
    // which imports this file, so a static import would be a cycle.
    const { collectBundleKnownSecrets, redactRawLogText } = await import("./debug.js");
    const knownSecrets = await collectBundleKnownSecrets().catch(() => []);
    const view = await consoleLogView(req);
    const redactLine = (line) => view.lines([redactRawLogText(line, knownSecrets)])[0];

    const size = stats.size;
    const start = Math.max(0, size - CONSOLE_LOG_DOWNLOAD_MAX_BYTES);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${consoleLogDownloadFileName(activeServer?.name)}"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (size === 0) return res.end();

    let skipPartialLine = start > 0;
    const lineMap = createLineMapStream((line) => {
      // Started mid-file: the first line is a fragment.
      if (skipPartialLine) {
        skipPartialLine = false;
        return `[Only the last ${Math.round(CONSOLE_LOG_DOWNLOAD_MAX_BYTES / 1024 / 1024)} MB of this ${Math.round(size / 1024 / 1024)} MB log are included]`;
      }
      return redactLine(line);
    });
    const source = fs.createReadStream(consoleLogPath, { start, end: size - 1 });
    await pipeline(source, lineMap, res);
  } catch (error) {
    log.error(`Failed to download server console log: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: sanitizeError(error.message) });
    } else {
      res.destroy(error);
    }
  }
});

// How many errors the game has thrown, so the dashboard can stop being calm
// while the server is screaming. Counted from the most recent "SERVER STARTED"
// marker when one is present in the sampled tail, otherwise across the sample.
let errorCountCache = { at: 0, value: null };
const ERROR_COUNT_TTL_MS = 20000;

router.get("/console-log/error-count", requirePermission("server.world_events"), async (req, res) => {
  try {
    const now = Date.now();
    if (errorCountCache.value && now - errorCountCache.at < ERROR_COUNT_TTL_MS) {
      return res.json(errorCountCache.value);
    }

    const activeServer = await getActiveServer();
    // PATHS-1: see the comment above GET /console-log.
    const zomboidDataPath = (await resolveConsoleLogFolder(activeServer)).folder;

    if (!zomboidDataPath) {
      return res.json({ exists: false, count: 0, sinceStart: false });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");
    if (!fs.existsSync(consoleLogPath)) {
      return res.json({ exists: false, count: 0, sinceStart: false });
    }

    // Only ever read the tail. This endpoint is polled, so it must stay cheap
    // no matter how large the log has grown.
    const MAX_READ_BYTES = 2 * 1024 * 1024;
    const stats = fs.statSync(consoleLogPath);
    let content;
    let truncated = false;
    if (stats.size > MAX_READ_BYTES) {
      truncated = true;
      const fd = fs.openSync(consoleLogPath, "r");
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      try {
        fs.readSync(fd, buffer, 0, MAX_READ_BYTES, stats.size - MAX_READ_BYTES);
      } finally {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* ignore */
        }
      }
      const raw = buffer.toString("utf-8");
      const firstNewline = raw.indexOf("\n");
      content = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    } else {
      content = fs.readFileSync(consoleLogPath, "utf-8");
    }

    const lines = content.split("\n");
    let startIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/SERVER STARTED/.test(lines[i])) {
        startIndex = i;
        break;
      }
    }
    const scanned = startIndex >= 0 ? lines.slice(startIndex) : lines;
    const count = scanned.filter((line) =>
      CONSOLE_LOG_ERROR_PATTERNS.some((pattern) => pattern.test(line)),
    ).length;

    const payload = {
      exists: true,
      count,
      sinceStart: startIndex >= 0,
      truncated,
      lastModified: stats.mtime.toISOString(),
    };
    errorCountCache = { at: now, value: payload };
    res.json(payload);
  } catch (error) {
    log.error(`Failed to count console log errors: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// continuous-bug-hunt round 13 (log tail truth): a poll's byte range can
// end mid-line -- PZ hasn't finished writing that line yet -- and without
// holding the fragment back, it used to be emitted as if it were a
// complete line THIS poll, then the rest of the SAME line reappeared as
// its own garbled fragment-of-a-line on the NEXT poll once the write
// finished: exactly "partial lines split across reads". services/
// logTailer.js's own _splitLines()/remainder fields already solve this
// identical problem for the OTHER console-log reader this app has (a
// single, sequential, stateful tailer) -- same fix here, adapted for this
// endpoint's stateless, client-supplied-offset shape.
//
// Keyed by the exact (path, byte offset) the remainder was captured at --
// `resumeAtSize` is the `currentSize` this same response cycle hands back
// to the client, i.e. the offset its OWN next poll's `lastSize` will carry
// -- so a stored fragment only ever gets reattached to whichever poll
// resumes from exactly that point.
//
// round 13b (god-caught follow-up): a single shared slot is worse than no
// buffering at all with two concurrent pollers. Viewer A's poll withholds
// fragment F and stores it at (path, S1); viewer B then polls at a
// DIFFERENT offset and the single slot's assignment overwrites F outright.
// A's next poll (still resuming from S1) finds no match -- F is gone, not
// merely re-split, so the start of that line never reaches A at all. A
// bounded map keyed by (path, resumeAtSize) lets each poller's fragment
// wait for ITS OWN matching next poll independently, however many pollers
// are interleaved, without one clobbering another's slot. Consumed
// (deleted) on a successful match, same as a real tail cursor -- once
// reattached, that exact fragment can't be reattached again to a
// different poller that happens to share the same (path, resumeAtSize)
// (which would only occur if TWO pollers were somehow at the identical
// offset, an ambiguous case no key scheme can tell apart anyway; deleting
// it is the same "first past the post wins" tradeoff the old slot already
// made implicitly). Capped at CONSOLE_STREAM_REMAINDER_MAX_ENTRIES,
// oldest-inserted evicted first, so an abandoned poller (a closed tab that
// never sends its matching follow-up) can't grow this without bound.
const CONSOLE_STREAM_REMAINDER_MAX_ENTRIES = 16;
const CONSOLE_STREAM_REMAINDER_CAP_BYTES = 64 * 1024;
const consoleStreamRemainders = new Map(); // `${path}\u0000${resumeAtSize}` -> text

function consoleStreamRemainderKey(consoleLogPath, resumeAtSize) {
  return `${consoleLogPath}\u0000${resumeAtSize}`;
}

// A rotation/shrink means every fragment on file for this path was
// captured against byte offsets in a file that no longer exists in that
// shape -- reattaching any of them to whatever comes next (a fresh
// full-file read) would glue unrelated content together.
function clearConsoleStreamRemaindersForPath(consoleLogPath) {
  const prefix = `${consoleLogPath}\u0000`;
  for (const key of consoleStreamRemainders.keys()) {
    if (key.startsWith(prefix)) consoleStreamRemainders.delete(key);
  }
}

function storeConsoleStreamRemainder(consoleLogPath, resumeAtSize, text) {
  if (!text) return; // nothing to hold back; no entry needed for a clean line boundary
  const key = consoleStreamRemainderKey(consoleLogPath, resumeAtSize);
  consoleStreamRemainders.delete(key); // re-inserting moves it to the newest end below
  consoleStreamRemainders.set(key, text);
  while (consoleStreamRemainders.size > CONSOLE_STREAM_REMAINDER_MAX_ENTRIES) {
    const oldestKey = consoleStreamRemainders.keys().next().value;
    consoleStreamRemainders.delete(oldestKey);
  }
}

// Splits `content` into complete lines, holding back a trailing partial
// line for the caller to store via storeConsoleStreamRemainder(). Consumes
// (deletes) any matching held-back fragment on use. `resumeFromSize`
// identifies which prior remainder (if any) belongs immediately before
// this content -- pass -1 when there is no meaningful "resumed from"
// position (a full-file re-read after a rotation), since -1 can never
// equal a real byte offset and so never wrongly glues a stale fragment
// onto unrelated content.
function splitConsoleStreamLines(consoleLogPath, resumeFromSize, content) {
  let combined = content;
  if (resumeFromSize >= 0) {
    const key = consoleStreamRemainderKey(consoleLogPath, resumeFromSize);
    const stored = consoleStreamRemainders.get(key);
    if (stored !== undefined) {
      combined = stored + combined;
      consoleStreamRemainders.delete(key);
    }
  }
  const parts = combined.split("\n");
  let remainder = parts.pop() ?? "";
  // Same cap as LogTailer's own _splitLines(): stops a newline-free file
  // from growing the held-back buffer without limit.
  if (remainder.length > CONSOLE_STREAM_REMAINDER_CAP_BYTES) remainder = "";
  return { completeLines: parts, remainder };
}

// continuous-bug-hunt round 14 (console stream file identity, follow-up to
// round 13): the existing `stats.size < lastSize` check below only ever
// catches a rotation that SHRINKS the file. PZ recreating server-console.txt
// on restart -- or the active server switching to a different server's own
// consoleLogPath -- produces a BRAND NEW file that starts at 0 and can
// easily grow PAST the client's old lastSize within a single ~2s poll
// window (a verbose PZ startup burst) before anyone notices: the size-only
// check then reads bytes [lastSize, stats.size) of the WRONG (new) file,
// silently skipping its own first `lastSize` bytes forever.
//
// Design choice (server-side identity, not a client-echoed token): this
// route already keeps small per-path module state for the remainder
// buffer above (rounds 13/13b) -- tracking "which file (by inode, or
// birthtime when inode is unavailable) did we last see at this path" is
// the same established idiom and needs ZERO client changes, since the
// comparison is entirely server-side. A token-echo scheme (return an
// identity token, have the client send it back next poll) would touch
// client/src/pages/Console.tsx AND client/src/lib/api.ts for no
// correctness benefit this approach doesn't already provide, and would
// still need its own "no token yet" fallback for a client's very first
// request -- exactly the ambiguous case this approach resolves for free
// (see consoleLogIdentityChanged's own comment). Smaller, self-contained,
// server-only diff -- the client's existing lastSize-only contract keeps
// working completely unmodified.
//
// Sharing one identity map across every concurrently-polling client is
// safe, unlike the remainder buffer: file identity is a single objective
// server-side fact (which file currently sits at this path), not
// per-reader state, so there is no round-13b-style "one poller's entry
// clobbers another's" risk here.
//
// 2026-10-12 (console audit): that map alone gave only the FIRST poller
// after a recreate its rotation -- it updated the shared record while
// answering, so a second open Console tab compared itself with the record
// the first tab had just refreshed, saw "no change", and read its stale
// lastSize range out of the new file. A client now echoes the identity token
// (`identity`) it was last given, and the comparison is made against THAT, so
// every tab sees its own rotation. The shared map stays: it holds the
// birthtime proof below, and is the baseline for a client that sends no
// token (a page loaded before this change). GET /console-log seeds it, so
// the first stream poll of a path is not "never seen" just because the
// panel process has not streamed it yet.
let consoleStreamKnownIdentity = new Map(); // path -> {birthtimeMs, ino, ctimeMs, birthtimeProvenReal}

// What a client holds on to and sends back: inode and birth time of the file
// its lastSize belongs to. Whether the birth time counts is the server's
// call (birthtimeProvenReal), so the token always carries both.
function consoleLogIdentityToken(stats) {
  return `${stats.ino || 0}:${stats.birthtimeMs || 0}`;
}

function parseConsoleLogIdentityToken(token) {
  if (typeof token !== "string" || token.length > 64) return null;
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(token);
  if (!match) return null;
  return { ino: Number(match[1]), birthtimeMs: Number(match[2]) };
}

// Records what is at this path now (and the birthtime proof) and hands back
// the record it replaced, if any.
function observeConsoleLogIdentity(consoleLogPath, stats) {
  const known = consoleStreamKnownIdentity.get(consoleLogPath);
  const ctimeMs = stats.ctimeMs || 0;
  const birthtimeMs = stats.birthtimeMs || 0;
  // CI-red-2026-09-18 (round 33b, god's regression catch): Node's own docs
  // warn that on a filesystem with no real creation-time tracking,
  // stats.birthtime instead reports ctime -- which changes on every
  // ordinary write, not just on create. Blindly OR-ing birthtime into the
  // identity check (round 33's first attempt) would then misreport EVERY
  // poll of a growing file on such a filesystem as a rotation. There is no
  // way to tell "real birthtime, unchanged since creation" apart from
  // "ctime-backed fake birthtime, freshly created" from a single stat()
  // call alone -- both look identical (birthtimeMs === ctimeMs) at that
  // exact moment. But a CTIME-BACKED value can NEVER show
  // birthtimeMs !== ctimeMs at ANY stat call, ever, since it is literally
  // the same underlying field -- so observing that inequality even once
  // for a given path is conclusive proof this path's filesystem tracks a
  // real, write-independent birth time. birthtimeProvenReal latches true
  // the first time that happens and is never unset -- filesystem birthtime
  // support does not change while the process runs. Kept PER-PATH (not a
  // single global flag): two different consoleLogPath values (different
  // servers' data directories) can genuinely sit on different filesystems
  // with different birthtime support, so proof gathered for one path must
  // not be assumed for another. Before it is proven for a path, birthtime
  // is ignored there entirely and only inode is used -- the exact
  // pre-round-33 behavior, so this is no worse than before on such a
  // filesystem. In practice the proof establishes itself within the first
  // couple of polls of any file that's actually growing (ctime overtakes a
  // real birthtime the moment anything writes to it), so the residual gap
  // -- an inode-reuse recreate going undetected -- is bounded to the brief
  // window before any growth has been observed on that path yet.
  const birthtimeProvenReal =
    Boolean(known?.birthtimeProvenReal) ||
    Boolean(birthtimeMs && ctimeMs && birthtimeMs !== ctimeMs);
  const current = {
    birthtimeMs,
    ctimeMs,
    ino: stats.ino || 0,
    birthtimeProvenReal,
  };
  consoleStreamKnownIdentity.set(consoleLogPath, current);
  return { known, current };
}

// Is `current` still the file `before` ({ino, birthtimeMs}) described?
//
// Inode equality alone is not sufficient proof of "same file": a
// delete+recreate at the same path can have its inode number handed
// straight back by the filesystem (routine on tmpfs -- which is what
// os.tmpdir()/CI's /tmp commonly is on Linux, and not uncommon on ext4
// for a near-empty directory, exactly what a fresh temp dir or PZ's own
// Server/ folder looks like). birthtime, when proven real for this path
// (see observeConsoleLogIdentity), is unaffected by inode reuse and
// catches that case.
function isSameConsoleLogFile(before, current) {
  const inoKnown = current.ino && before.ino;
  if (inoKnown && current.ino !== before.ino) return false;
  const birthtimeKnown = current.birthtimeMs && before.birthtimeMs;
  if (
    current.birthtimeProvenReal &&
    birthtimeKnown &&
    current.birthtimeMs !== before.birthtimeMs
  ) {
    return false;
  }
  return true; // neither available/trustworthy signal differs -- no worse than before this fix
}

// Returns true when the file at this path is not the one the caller's
// lastSize belongs to -- deleted and recreated since it last looked (a PZ
// restart, or an active-server switch to a different consoleLogPath).
//
// `clientIdentity` is the token this route gave the client with its previous
// answer. With one, the client's own file is the baseline. Without one (a
// page loaded before tokens existed, or a first request that had nothing to
// echo), the shared record is: a path never seen before is treated as
// "changed" and forces a full resync, because it is either this process's
// first look at the path or an active-server switch to a path carrying a
// lastSize calibrated for a DIFFERENT file, and the two cannot be told
// apart. GET /console-log seeds the record, so an ordinary page load is
// neither.
function consoleLogIdentityChanged(consoleLogPath, stats, clientIdentity) {
  const { known, current } = observeConsoleLogIdentity(consoleLogPath, stats);
  const claimed = parseConsoleLogIdentityToken(clientIdentity);
  if (claimed) return !isSameConsoleLogFile(claimed, current);
  if (!known) return true;
  return !isSameConsoleLogFile(known, current);
}

// The most one /console-log/stream response reads from the file. The route
// used to read the whole file on a rotation (the first poll of every path in
// a process counted as one) and every byte since lastSize otherwise, so a
// log of hundreds of megabytes, or a client returning after a long absence,
// became one huge read, response and render. Past this the answer is the
// last stretch of the range, with `truncated: true`.
const CONSOLE_STREAM_MAX_READ_BYTES = 256 * 1024;

// Bytes [start, end) of the file as text, at most the last
// CONSOLE_STREAM_MAX_READ_BYTES of them. When the range is longer the read
// starts that far from the end and the first line, probably cut, is dropped.
//
// SECURITY (2026-10-20): `start` is the client's lastSize. With
// `wholeLinesOnly` (no held-back fragment of the line before it, see
// splitConsoleStreamLines) a start in the middle of a line drops the rest of
// that line too: answering from any byte offset handed out the tail of a line
// without its head, so lastSize aimed just past "Command line admin
// password: " returned the bare password, out of reach of the line's
// redaction (utils/gameLogSecrets.js).
function readConsoleLogRange(consoleLogPath, start, end, { wholeLinesOnly = false } = {}) {
  let from = start;
  let truncated = false;
  if (end - start > CONSOLE_STREAM_MAX_READ_BYTES) {
    from = end - CONSOLE_STREAM_MAX_READ_BYTES;
    truncated = true;
  }
  // One byte more in front says whether `from` begins a line.
  const peek = wholeLinesOnly && !truncated && from > 0 ? 1 : 0;
  const length = Math.max(0, end - from + peek);
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  const fd = fs.openSync(consoleLogPath, "r");
  try {
    bytesRead = fs.readSync(fd, buffer, 0, length, from - peek);
  } finally {
    try {
      fs.closeSync(fd);
    } catch (_) {
      /* ignore */
    }
  }
  let text = buffer.toString("utf-8", peek, Math.max(peek, bytesRead));
  const startsMidLine = peek === 1 && bytesRead > 0 && buffer[0] !== 0x0a;
  if (truncated || startsMidLine) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }
  return { text, truncated };
}

// Stream server console log (long-polling for new content)
router.get("/console-log/stream", requirePermission("server.world_events"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    // PATHS-1: see the comment above GET /console-log.
    const consoleLogFolder = await resolveConsoleLogFolder(activeServer);
    if (consoleLogFolder.remote || consoleLogFolder.refused) {
      return res.json({
        success: true,
        newLines: [],
        exists: false,
        ...(consoleLogFolder.refusal ? { refusal: consoleLogFolder.refusal } : {}),
      });
    }
    const zomboidDataPath = consoleLogFolder.folder;

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Server data path not configured", code: ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED });
    }

    const consoleLogPath = path.join(zomboidDataPath, CONSOLE_LOG_FILE_NAME);

    if (!fs.existsSync(consoleLogPath)) {
      return res.json({ success: true, newLines: [], exists: false });
    }
    const view = await consoleLogView(req);

    // Filter level: 'all' | 'filtered' | 'important' | 'errors'
    const filterLevel = req.query.filter || "filtered";

    // Get the last known position from client
    const lastSize = parseBoundedInteger(
      req.query.lastSize,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const stats = fs.statSync(consoleLogPath);
    const identityChanged = consoleLogIdentityChanged(
      consoleLogPath,
      stats,
      req.query.identity,
    );
    // Echoed back by the client with its next poll (see
    // consoleLogIdentityChanged); also what lets a second open page notice a
    // rotation the first one already consumed.
    const identity = consoleLogIdentityToken(stats);

    // If file is smaller than last known size, OR a different file (by
    // inode/birthtime) now exists at this same path -- PZ recreated its
    // console log on restart, or the active server switched to a
    // different server's own consoleLogPath -- treat it as rotated: the
    // size-alone check below would otherwise stay silent whenever the new
    // file is already >= lastSize by the time this poll runs.
    if (identityChanged || stats.size < lastSize) {
      clearConsoleStreamRemaindersForPath(consoleLogPath);
      // Only the end of the new file: a long log is not worth shipping whole
      // to a pane that keeps the last few hundred lines.
      const { text: content, truncated } = readConsoleLogRange(
        consoleLogPath,
        0,
        stats.size,
      );
      const { completeLines, remainder } = splitConsoleStreamLines(
        consoleLogPath,
        -1,
        content,
      );
      storeConsoleStreamRemainder(consoleLogPath, stats.size, remainder);
      const allLines = completeLines.filter((l) => l.trim());
      const lines = view.lines(filterConsoleLogLines(allLines, filterLevel));
      return res.json({
        success: true,
        newLines: lines,
        currentSize: stats.size,
        rotated: true,
        ...(truncated ? { truncated: true } : {}),
        identity,
        filterLevel,
        lastModified: stats.mtime.toISOString(),
      });
    }

    // If no new content, return empty
    if (stats.size === lastSize) {
      return res.json({
        success: true,
        newLines: [],
        currentSize: stats.size,
        identity,
        filterLevel,
        lastModified: stats.mtime.toISOString(),
      });
    }

    // Read only new content from the last known position -- the last
    // CONSOLE_STREAM_MAX_READ_BYTES of it when the client is further behind
    // than that, in which case the held-back fragment of its old position no
    // longer belongs in front of what is read (resume -1). Without a
    // held-back fragment for lastSize, the read starts on a whole line
    // (readConsoleLogRange's wholeLinesOnly).
    const { text: newContent, truncated } = readConsoleLogRange(
      consoleLogPath,
      lastSize,
      stats.size,
      {
        wholeLinesOnly: !consoleStreamRemainders.has(
          consoleStreamRemainderKey(consoleLogPath, lastSize),
        ),
      },
    );
    const { completeLines, remainder } = splitConsoleStreamLines(
      consoleLogPath,
      truncated ? -1 : lastSize,
      newContent,
    );
    storeConsoleStreamRemainder(consoleLogPath, stats.size, remainder);
    const allNewLines = completeLines.filter((l) => l.trim());
    const newLines = view.lines(filterConsoleLogLines(allNewLines, filterLevel));

    res.json({
      success: true,
      newLines,
      currentSize: stats.size,
      ...(truncated ? { truncated: true } : {}),
      identity,
      filterLevel,
      lastModified: stats.mtime.toISOString(),
    });
  } catch (error) {
    log.error(`Failed to stream server console log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Clear server console log
router.post("/console-log/clear", requirePermission("server.configure"), async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    // PATHS-1: see the comment above GET /console-log.
    const consoleLogFolder = await resolveConsoleLogFolder(activeServer);
    if (consoleLogFolder.remote) {
      return res.status(400).json({
        error:
          "A remote server's console log is on its own host, so the panel can't clear it from here.",
        code: ErrorCode.SERVER_CONSOLE_LOG_REMOTE_NOT_AVAILABLE,
      });
    }
    if (consoleLogFolder.refused) {
      return res.status(400).json(consoleLogFolder.refusal);
    }
    const zomboidDataPath = consoleLogFolder.folder;

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Server data path not configured", code: ErrorCode.SERVER_DATA_PATH_NOT_CONFIGURED });
    }

    const consoleLogPath = path.join(zomboidDataPath, "server-console.txt");

    if (fs.existsSync(consoleLogPath)) {
      fs.writeFileSync(consoleLogPath, "");
      log.info("Server console log cleared");
    }

    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to clear server console log: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ==================== UPDATE CHECKER ROUTES ====================

// Check for server updates
router.get("/update-check", requirePermission("server.world_events"), async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available", code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE });
    }

    const forceCheck = req.query.force === "true";

    if (forceCheck) {
      const result = await updateChecker.checkForUpdates(true);
      res.json(result || { error: "Could not check for updates", code: ErrorCode.UPDATE_CHECK_NO_RESULT });
    } else {
      res.json(await updateChecker.getStatus());
    }
  } catch (error) {
    log.error(`Update check failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get update checker status
router.get("/update-check/status", requirePermission("server.world_events"), async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available", code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE });
    }

    res.json(await updateChecker.getStatus());
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Acknowledge the last automatic-update result so its banner stops showing.
// Shared server-side state (not per-browser localStorage) deliberately: a
// failure one admin dismisses must not vanish for another admin or another
// device that never saw it.
router.post("/update-check/auto-update-result/dismiss", requirePermission("server.world_events"), async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available", code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE });
    }

    await updateChecker.dismissAutoUpdateResult();
    res.json(await updateChecker.getStatus());
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set update check interval
router.post("/update-check/interval", requirePermission("server.configure"), async (req, res) => {
  try {
    const updateChecker = req.app.get("updateChecker");
    if (!updateChecker) {
      return res.status(503).json({ error: "Update checker not available", code: ErrorCode.UPDATE_CHECKER_NOT_AVAILABLE });
    }

    const { minutes } = req.body || {};
    if (!minutes || typeof minutes !== "number") {
      return res.status(400).json({ error: "minutes must be a number", code: ErrorCode.UPDATE_CHECK_INTERVAL_INVALID });
    }

    await updateChecker.setInterval(minutes);
    res.json({ success: true, intervalMinutes: minutes });
  } catch (error) {
    log.error(`Failed to set update check interval: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ── Server Wipe ──────────────────────────────────────────────────────────────

// Guard against concurrent wipe operations
let wipeInProgress = false;

// Run `worker` over `items` with at most `limit` in flight at once. Mirrors
// chunks.js's runWithConcurrency (same reasoning: unbounded Promise.all over
// a directory with hundreds of entries can exhaust file handles or, on slow
// storage, queue so many concurrent round trips that it's slower than doing
// them one at a time) -- duplicated locally rather than imported since
// chunks.js doesn't export it and these two route files don't otherwise
// depend on each other.
const WIPE_PREVIEW_WALK_CONCURRENCY = 8;
async function runWithConcurrencyBounded(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

// Recursively count files and total size under `dir`. Was fully synchronous
// (fs.readdirSync/fs.statSync, no concurrency, no cap) -- Jim measured 20.7
// SECONDS for map/ alone on a 147,136-file save, fully blocking the Node
// event loop that whole time for every other admin session and RCON call on
// the panel, not just the requester's own page. Now async with bounded
// per-level concurrency (same shape as chunks.js's getDirStats) and a
// shared `budget` -- a wall-clock deadline plus an entry cap, same pattern
// as debug.js's scanSaveStats -- so a pathologically large or slow-storage
// save can't hang the request open-endedly. Once the budget runs out,
// `budget.truncated` is set and every further call returns zero rather than
// silently continuing to count: the caller MUST report that flag rather
// than presenting a wipe-preview number that quietly stopped being exact.
export async function countDir(dir, budget) {
  if (budget.truncated || Date.now() >= budget.deadline || budget.visited >= budget.maxEntries) {
    budget.truncated = true;
    return { files: 0, size: 0 };
  }
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    log.debug(`countDir readdir failed for ${dir}: ${e.message}`);
    return { files: 0, size: 0 };
  }
  const results = await runWithConcurrencyBounded(
    entries,
    WIPE_PREVIEW_WALK_CONCURRENCY,
    async (entry) => {
      if (budget.truncated || Date.now() >= budget.deadline || budget.visited >= budget.maxEntries) {
        budget.truncated = true;
        return { files: 0, size: 0 };
      }
      budget.visited++;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return countDir(fullPath, budget);
      }
      let size = 0;
      try {
        const stat = await fs.promises.stat(fullPath);
        size = stat.size;
      } catch (e) {
        log.debug(`Stat failed for ${fullPath}: ${e.message}`);
      }
      return { files: 1, size };
    },
  );
  let files = 0;
  let size = 0;
  for (const r of results) {
    files += r.files;
    size += r.size;
  }
  return { files, size };
}

// Preview what will be wiped (dry-run). Admin-only, same as /wipe itself --
// this pairs with the actual wipe, so anyone who can't wipe has no reason
// to preview one.
// SECURITY (2026-10-05, PATHS-1 verifier pass 2): a remote server's world
// is on its own host, and its record's data folder -- never judged when
// saved -- names a path there, yet /wipe deleted under <that folder>/Saves/
// Multiplayer/<name> on this computer (only its pre-wipe backup refused a
// remote server). The Dashboard already disables Wipe for a remote server;
// both routes now refuse one too, as backups and the console log do.
function wipeRemoteRefusal() {
  return {
    error: "A remote server's world is on its own host, so the panel can't wipe it from here.",
    code: ErrorCode.WIPE_REMOTE_NOT_AVAILABLE,
  };
}

router.post("/wipe/preview", requirePermission("server.wipe"), async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    // path-resolution sweep, 2026-09-06: this used to read serverManager's
    // CACHED savePath/serverName, refreshed only by an explicit
    // reloadConfig() (servers.js's /:id/activate and PUT /servers/:id) --
    // a failed reload there is treated as best-effort (the DB write is
    // never rolled back, see servers.js:1706-1710) and serverManager's own
    // loadConfig() is a no-op once already loaded (serverManager.js:525),
    // so it does NOT self-heal. backupService.js's getSavesPath() /
    // getBackupsPath() -- used by /wipe's own pre-wipe backup -- always
    // re-read getActiveServer() fresh from the DB, independent of
    // serverManager. Two derivations of "the active server's save path"
    // that agree under normal conditions but can silently diverge when an
    // earlier reload failed -- collapsed here onto ONE fresh source
    // (getActiveServer(), matching backupService's own already-correct
    // approach) instead of reconciling two. reloadConfig() (a REAL reload,
    // not the guarded loadConfig() above) is forced so the stopped-check in
    // /wipe itself (getServerProcessDetails(), which depends on
    // serverManager's OTHER cached fields -- serverPath, serverBat,
    // launchMode -- to find the right OS process) examines this same
    // server too, rather than whatever serverManager last successfully
    // loaded. A reload failure here fails the preview closed instead of
    // silently describing a possibly-wrong server -- see the follow-up
    // report on whether activate/update's own best-effort posture should
    // change; not touched here.
    const activeServer = await getActiveServer();
    if (!activeServer) {
      return res.status(400).json({ error: "No active server configured", code: ErrorCode.WIPE_ZOMBOID_DATA_PATH_NOT_CONFIGURED });
    }
    if (activeServer.isRemote) {
      return res.status(400).json(wipeRemoteRefusal());
    }
    try {
      await serverManager.reloadConfig();
    } catch (e) {
      return res.status(503).json({
        error: "Could not verify the active server's configuration — refusing to preview a wipe against possibly-stale state. Try again, or restart the panel.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }

    const { targets } = req.body || {}; // e.g. ["map", "players", "world"]
    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({
        error:
          "targets must be a non-empty array of: map, players, world, accounts",
        code: ErrorCode.WIPE_TARGETS_REQUIRED,
      });
    }

    // "accounts" lives outside the save folder, so it is not part of the sweep
    const SAVE_TARGETS = ["map", "players", "world"];
    const allowedTargets = [...SAVE_TARGETS, "accounts"];
    const invalid = targets.filter((t) => !allowedTargets.includes(t));
    if (invalid.length > 0) {
      return res.status(400).json({
        error: `Invalid targets: ${invalid.join(", ")}. Allowed: ${allowedTargets.join(", ")}`,
        code: ErrorCode.WIPE_PREVIEW_INVALID_TARGETS,
      });
    }

    const savePath = activeServer.zomboidDataPath;
    const serverName = activeServer.serverName || "servertest";
    if (!savePath) {
      return res.status(400).json({ error: "No zomboid data path configured", code: ErrorCode.WIPE_ZOMBOID_DATA_PATH_NOT_CONFIGURED });
    }
    // Reject server names with path separators
    if (/[/\\]/.test(serverName)) {
      return res.status(400).json({ error: "Invalid server name", code: ErrorCode.WIPE_INVALID_SERVER_NAME });
    }

    const saveDir = path.join(savePath, "Saves", "Multiplayer", serverName);
    if (!fs.existsSync(saveDir)) {
      return res
        .status(404)
        .json({ error: `Save directory not found: ${serverName}`, code: ErrorCode.WIPE_SAVE_DIRECTORY_NOT_FOUND });
    }

    const preview = {};
    let totalFiles = 0;
    let totalSize = 0;
    // Shared across every countDir() call below so the budget covers the
    // WHOLE preview request (every target's directories combined), not each
    // directory independently -- otherwise several individually-under-
    // budget walks could still add up to the multi-second block this fix
    // exists to remove. 15s / 300,000 entries is generous headroom over
    // Jim's 20.7s/147,136-file measurement (which was the fully synchronous,
    // no-concurrency walk); truncation is a backstop for pathological or
    // slow-storage cases, not an expected outcome for a normal save.
    const budget = {
      deadline: Date.now() + 15_000,
      visited: 0,
      maxEntries: 300_000,
      truncated: false,
    };

    // Directories belonging to each target
    const MAP_DIRS = [
      "map",
      "chunkdata",
      "isoregiondata",
      "zpop",
      "apop",
      "metagrid",
      "map_visited_server",
    ];
    const WORLD_DIRS = ["radio"];
    // Player files in save root
    const PLAYER_ROOT_FILES =
      /^(players\.db|players\.db-journal|vehicles\.db|vehicles\.db-journal|map_p\.bin|map_zone\.bin)$/i;
    // World state files in save root (everything that isn't player data or directories)
    // This covers WorldDictionary.bin, map_meta.bin, map_t.bin, entity_data.bin,
    // global_mod_data.bin, reanimated.bin, iTrack.bin, gos_*.bin, map_*.bin (except map_zone/map_p),
    // z_outfits.bin, recorded_media.bin, erosion.ini, WorldDictionary*.lua, etc.
    const WORLD_ROOT_FILES =
      /^(WorldDictionary.*|map_meta\.bin|map_t\.bin|map_worldgen\.bin|map_animals\.bin|map_basements\.bin|entity_data\.bin|global_mod_data\.bin|reanimated\.bin|iTrack\.bin|gos_.*\.bin|id_manager_data\.bin|important_area_data\.bin|z_outfits\.bin|recorded_media\.bin|servermap_symbols\.bin|map_sand\.bin|hidden_authors\.ini|erosion\.ini)$/i;

    if (targets.includes("map")) {
      let mapFiles = 0;
      let mapSize = 0;
      for (const dirName of MAP_DIRS) {
        const dir = path.join(saveDir, dirName);
        if (fs.existsSync(dir)) {
          const sub = await countDir(dir, budget);
          mapFiles += sub.files;
          mapSize += sub.size;
        }
      }
      preview.map = { files: mapFiles, size: mapSize };
      totalFiles += mapFiles;
      totalSize += mapSize;
    }

    if (targets.includes("players")) {
      let playerFiles = 0;
      let playerSize = 0;
      try {
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && PLAYER_ROOT_FILES.test(entry.name)) {
            playerFiles++;
            try {
              playerSize += fs.statSync(path.join(saveDir, entry.name)).size;
            } catch (e) {
              log.debug(
                `Stat failed for player file ${entry.name}: ${e.message}`,
              );
            }
          }
        }
      } catch (e) {
        log.debug(`Player file scan failed: ${e.message}`);
      }
      preview.players = { files: playerFiles, size: playerSize };
      totalFiles += playerFiles;
      totalSize += playerSize;
    }

    if (targets.includes("world")) {
      let worldFiles = 0;
      let worldSize = 0;
      // Count world directories
      for (const dirName of WORLD_DIRS) {
        const dir = path.join(saveDir, dirName);
        if (fs.existsSync(dir)) {
          const sub = await countDir(dir, budget);
          worldFiles += sub.files;
          worldSize += sub.size;
        }
      }
      // Count world root files
      try {
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && WORLD_ROOT_FILES.test(entry.name)) {
            worldFiles++;
            try {
              worldSize += fs.statSync(path.join(saveDir, entry.name)).size;
            } catch (e) {
              log.debug(
                `Stat failed for world file ${entry.name}: ${e.message}`,
              );
            }
          }
        }
      } catch (e) {
        log.debug(`World file scan failed: ${e.message}`);
      }
      preview.world = { files: worldFiles, size: worldSize };
      totalFiles += worldFiles;
      totalSize += worldSize;
    }

    // Selecting every target means a total wipe, so account for anything the
    // per-target lists don't recognise (mod files, stale backups, new formats).
    if (SAVE_TARGETS.every((t) => targets.includes(t))) {
      const claimed = new Set([...MAP_DIRS, ...WORLD_DIRS]);
      let extraFiles = 0;
      let extraSize = 0;
      try {
        for (const entry of fs.readdirSync(saveDir, { withFileTypes: true })) {
          if (claimed.has(entry.name)) continue;
          if (
            !entry.isDirectory() &&
            (PLAYER_ROOT_FILES.test(entry.name) ||
              WORLD_ROOT_FILES.test(entry.name))
          ) {
            continue;
          }
          const fullPath = path.join(saveDir, entry.name);
          if (entry.isDirectory()) {
            const sub = await countDir(fullPath, budget);
            extraFiles += sub.files;
            extraSize += sub.size;
          } else {
            extraFiles++;
            try {
              extraSize += fs.statSync(fullPath).size;
            } catch (e) {
              log.debug(`Stat failed for ${entry.name}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        log.debug(`Leftover scan failed: ${e.message}`);
      }
      preview.leftovers = { files: extraFiles, size: extraSize };
      totalFiles += extraFiles;
      totalSize += extraSize;
    }

    if (targets.includes("accounts")) {
      let accountFiles = 0;
      let accountSize = 0;
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        const dbFile = path.join(savePath, "db", `${serverName}.db${suffix}`);
        if (fs.existsSync(dbFile)) {
          accountFiles++;
          try {
            accountSize += fs.statSync(dbFile).size;
          } catch (e) {
            log.debug(`Stat failed for ${dbFile}: ${e.message}`);
          }
        }
      }
      preview.accounts = { files: accountFiles, size: accountSize };
      totalFiles += accountFiles;
      totalSize += accountSize;
    }

    res.json({
      success: true,
      serverName,
      saveDir,
      targets,
      preview,
      totalFiles,
      totalSize,
      // True if the walk hit its wall-clock/entry-count budget before
      // finishing -- the counts above are then a LOWER BOUND, not exact.
      // Never silently swallowed: the wipe dialog is about to act on these
      // numbers, so an operator seeing a truncated preview needs to know
      // it undercounts rather than trusting it as final.
      truncated: budget.truncated,
    });
  } catch (error) {
    log.error(`Wipe preview failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Execute server wipe
router.post("/wipe", requirePermission("server.wipe"), async (req, res) => {
  // Claim the guard before the first await: awaiting between the check and the
  // assignment lets a second concurrent request pass the check and run a
  // parallel destructive wipe of the same save directory.
  if (wipeInProgress) {
    return res.status(409).json({
      error: "A wipe operation is already in progress. Please wait.",
      code: ErrorCode.WIPE_IN_PROGRESS,
    });
  }
  wipeInProgress = true;

  // 2026-09-05 host-suspend-resume sweep: the "server must be stopped"
  // check below and the multi-minute pre-wipe backup that follows it were
  // not covered by any lock a concurrent /start could also see -- only
  // `wipeInProgress` (this-route-only) stood in the way, so a Start fired
  // during the backup passed straight through and this handler went on to
  // rmSync the save tree of a now-running server. restoreBackup() has the
  // exact same shape (checked-then-long-op-then-destructive) and is fixed
  // the same way in backupService.js: acquire the SAME process-wide
  // lifecycle lock /start, /stop, /restart already take, before the
  // stopped-check, held through the destructive step, released once in the
  // outer finally below alongside wipeInProgress.
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "wipe",
    activeServerForLock?.id ?? null,
  );
  if (!lifecycleLock) {
    wipeInProgress = false;
    return res.status(409).json(lifecycleInProgressResponse());
  }

  // Declared here, not with `const`/`let` inside the try below, so the
  // catch block can still see whatever these held at the moment of a
  // mid-wipe throw -- a try-scoped `const results = {}` is invisible to
  // its own catch in JS, which would have made the partial-failure report
  // below throw a ReferenceError instead of ever reaching the client.
  let serverName = null;
  let backupResult = null;
  let results = {};
  let targets = null;

  try {
    const serverManager = req.app.get("serverManager");
    // path-resolution sweep, 2026-09-06: serverManager.loadConfig() alone
    // (below) is a no-op once already loaded (serverManager.js:525) and
    // does NOT self-heal a stale manager -- see the matching comment on
    // /wipe/preview above for the full mechanism. Fetched fresh here
    // (not reusing activeServerForLock, computed before the lock above was
    // acquired) since the lifecycle lock now held for the rest of this
    // request guarantees the active server can't change under us -- this
    // read is the one source of truth the target path, the stopped-check,
    // and the pre-wipe backup below all now agree on, matching
    // backupService's own already-correct getActiveServer()-based
    // derivation instead of reconciling two different ones.
    const activeServer = await getActiveServer();
    if (!activeServer) {
      return res.status(400).json({ error: "No active server configured", code: ErrorCode.WIPE_ZOMBOID_DATA_PATH_NOT_CONFIGURED });
    }
    if (activeServer.isRemote) {
      return res.status(400).json(wipeRemoteRefusal());
    }

    // steamcmd-routes-running-check card: this route never checked for an
    // in-progress SteamCMD operation before wiping. A default install keeps
    // zomboidDataPath OUTSIDE installPath (see the nested-data-path comment
    // below), so this is normally a non-issue -- but nothing stops an
    // operator from nesting it inside installPath instead, and when that's
    // the configuration, a wipe running while POST /install or POST
    // /steam-update is actively writing into that same tree deletes/
    // recreates files SteamCMD has open. Same guard those two routes
    // already claim before spawning, reused here rather than a new lock --
    // activeSteamOperations is already scoped per install path.
    if (activeServer.installPath) {
      const normalizedWipeTargetPath = path
        .normalize(activeServer.installPath)
        .toLowerCase();
      if (hasActiveSteamOperation(normalizedWipeTargetPath)) {
        return res.status(409).json({
          error:
            "A Steam operation is already in progress for this path. Please wait for it to complete.",
          code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_PATH,
        });
      }
    }

    try {
      await serverManager.reloadConfig();
    } catch (e) {
      return res.status(503).json({
        error: "Could not verify the active server's configuration — refusing to wipe against possibly-stale state. Nothing was deleted. Try again, or restart the panel.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }

    // Safety: server must be stopped, and we must be SURE of that.
    // checkServerRunning() collapses a failed detection scan into `false`
    // (same as a confirmed-stopped server), which would let this destructive
    // wipe proceed against a server we simply failed to see was running.
    // getServerProcessDetails() exposes that distinction via scanFailed, so
    // fail closed when detection itself failed.
    //
    // The local process scan alone is also blind to a server running in
    // another container (a docker-local setup, GH#114): it succeeds and finds
    // nothing while the world is open in a live server. So the verdict is
    // resolveObservedServerRunning(), the one the status badge, the watchdog
    // and Discord use and POST /backup/restore/:name now gates on -- the
    // container's own state for the Docker providers, RCON and PanelBridge
    // alongside the scan otherwise. true refuses; null (cannot tell) refuses
    // as "can't verify".
    let observedRunning;
    try {
      observedRunning = await resolveObservedServerRunning(
        serverManager,
        req.app.get("rconService"),
      );
    } catch (error) {
      log.warn(`Could not tell whether the server is running before a wipe: ${error.message}`);
      observedRunning = null;
    }
    if (observedRunning === null) {
      return res.status(503).json({
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }
    if (observedRunning) {
      return res.status(400).json({
        error: "Server must be stopped before wiping. Stop the server first.",
        code: ErrorCode.WIPE_SERVER_RUNNING,
      });
    }

    let confirm, createBackup;
    ({ targets, confirm, createBackup = true } = req.body || {});
    if (confirm !== true) {
      return res.status(400).json({ error: "Wipe requires confirm: true", code: ErrorCode.WIPE_CONFIRM_REQUIRED });
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({
        error:
          "targets must be a non-empty array of: map, players, world, accounts",
        code: ErrorCode.WIPE_TARGETS_REQUIRED,
      });
    }

    // "accounts" lives outside the save folder, so it is not part of the sweep
    const SAVE_TARGETS = ["map", "players", "world"];
    const allowedTargets = [...SAVE_TARGETS, "accounts"];
    const invalid = targets.filter((t) => !allowedTargets.includes(t));
    if (invalid.length > 0) {
      return res
        .status(400)
        .json({ error: `Invalid targets: ${invalid.join(", ")}`, code: ErrorCode.WIPE_INVALID_TARGETS });
    }

    const savePath = activeServer.zomboidDataPath;
    serverName = activeServer.serverName || "servertest";
    if (!savePath) {
      return res.status(400).json({ error: "No zomboid data path configured", code: ErrorCode.WIPE_ZOMBOID_DATA_PATH_NOT_CONFIGURED });
    }
    if (/[/\\]/.test(serverName)) {
      return res.status(400).json({ error: "Invalid server name", code: ErrorCode.WIPE_INVALID_SERVER_NAME });
    }

    const saveDir = path.join(savePath, "Saves", "Multiplayer", serverName);
    if (!fs.existsSync(saveDir)) {
      return res
        .status(404)
        .json({ error: `Save directory not found: ${serverName}`, code: ErrorCode.WIPE_SAVE_DIRECTORY_NOT_FOUND });
    }

    // Path traversal safety
    const normalizedSaveDir = path.normalize(saveDir);
    if (normalizedSaveDir.includes("..")) {
      return res.status(400).json({ error: "Invalid path", code: ErrorCode.INVALID_PATH });
    }

    // Back up before wiping, fail CLOSED if the backup itself fails -- a wipe
    // that proceeds after a failed backup is strictly worse than no backup
    // option at all, because the operator now believes an undo exists. This
    // mirrors chunks.js's delete-chunks/delete-region convention (backup
    // first, propagate failure, never reach the deletion code below) but
    // uses backupService's streaming zip archiver rather than chunks.js's
    // per-file copy loop: a full world save can be many GB, and copying it
    // file-by-file the way chunks.js backs up a hand-picked chunk selection
    // has no place to report progress and no bound on how long the request
    // blocks. backupService.createBackup() already solves exactly this --
    // it's the same mechanism restoreBackup() uses for its own mandatory
    // pre-restore backup, streams to a .zip instead of materializing a
    // second copy of the save tree, reports progress over `io` the same way,
    // and is exempt from ad-hoc invention: it's the codebase's one existing
    // answer to "back up the whole world safely."
    if (createBackup) {
      const backupService = req.app.get("backupService");
      if (!backupService) {
        return res.status(500).json({
          error: "Backup service unavailable — refusing to wipe without a backup. Nothing was deleted.",
          code: ErrorCode.WIPE_BACKUP_FAILED,
        });
      }
      const io = req.app.get("io");
      backupResult = await backupService.createBackup({ isPreWipe: true, io });
      // 2026-08-26 bug hunt: createBackup can return success:true while
      // having silently skipped files -- a file that vanished mid-archive,
      // or (since 445c15a5, 2026-08-29) a symbolic link deliberately not
      // followed -- it surfaces that via skippedFiles rather than deciding
      // policy itself. This backup is about to become the ONLY copy of
      // whatever wipe is about to delete -- "mostly complete" is not a
      // safety net, so any skip is treated exactly like an outright backup
      // failure, same as the existing backup-or-abort posture below.
      const backupIncomplete =
        backupResult.success && (backupResult.skippedFiles?.length ?? 0) > 0;
      // SECURITY (2026-10-05, HT2): the reason is path-redacted, like the
      // partial-failure answer below. server.wipe can be a custom role
      // without the host-path capabilities, and the backup's own message
      // can quote the save or backups folder.
      if (!backupResult.success || backupIncomplete) {
        const reason = backupIncomplete
          ? `it could not include ${backupResult.skippedFiles.length} file(s) (${backupResult.skippedFiles.join(", ")}) -- an incomplete pre-wipe backup is not a safety net`
          : backupResult.message;
        return res.status(500).json({
          error: `Wipe aborted: could not create a backup first (${sanitizeError(reason)}). Nothing was deleted.`,
          code: ErrorCode.WIPE_BACKUP_FAILED,
        });
      }

      // The account/whitelist database lives at <zomboidDataPath>/db/, a
      // sibling of Saves/Multiplayer -- outside the tree backupService just
      // zipped. When "accounts" is one of the selected targets, the backup
      // above does not actually cover what's about to be deleted unless we
      // also copy it. These files are small (a sqlite whitelist db, not
      // world data), so a direct copy -- the same shape chunks.js uses for
      // its own per-file backups -- is the right tool here, unlike the
      // world save above.
      if (targets.includes("accounts")) {
        try {
          const accountsBackupDir = path.join(
            await backupService.getBackupsPath(),
            `${serverName}_accounts_${Date.now()}`,
          );
          await fs.promises.mkdir(accountsBackupDir, { recursive: true });
          for (const suffix of ["", "-journal", "-wal", "-shm"]) {
            const dbFile = path.join(savePath, "db", `${serverName}.db${suffix}`);
            if (fs.existsSync(dbFile)) {
              await fs.promises.copyFile(
                dbFile,
                path.join(accountsBackupDir, `${serverName}.db${suffix}`),
              );
            }
          }
        } catch (e) {
          log.error(`Wipe aborted: accounts database backup failed: ${e.message}`);
          return res.status(500).json({
            error: `Wipe aborted: could not back up the accounts database (${sanitizeError(e.message)}). Nothing was deleted.`,
            code: ErrorCode.WIPE_BACKUP_FAILED,
          });
        }
      }
    }

    results = {};

    // Same directory/file lists as preview
    const MAP_DIRS = [
      "map",
      "chunkdata",
      "isoregiondata",
      "zpop",
      "apop",
      "metagrid",
      "map_visited_server",
    ];
    const WORLD_DIRS = ["radio"];
    const PLAYER_ROOT_FILES =
      /^(players\.db|players\.db-journal|vehicles\.db|vehicles\.db-journal|map_p\.bin|map_zone\.bin)$/i;
    const WORLD_ROOT_FILES =
      /^(WorldDictionary.*|map_meta\.bin|map_t\.bin|map_worldgen\.bin|map_animals\.bin|map_basements\.bin|entity_data\.bin|global_mod_data\.bin|reanimated\.bin|iTrack\.bin|gos_.*\.bin|id_manager_data\.bin|important_area_data\.bin|z_outfits\.bin|recorded_media\.bin|servermap_symbols\.bin|map_sand\.bin|hidden_authors\.ini|erosion\.ini)$/i;

    try {
      if (targets.includes("map")) {
        let deletedCount = 0;
        for (const dirName of MAP_DIRS) {
          const dir = path.join(saveDir, dirName);
          if (fs.existsSync(dir)) {
            log.warn(`WIPE: Deleting ${dirName}/ at ${dir}`);
            fs.rmSync(dir, { recursive: true, force: true });
            deletedCount++;
          }
        }
        results.map =
          deletedCount > 0
            ? `deleted ${deletedCount} directories`
            : "not found";
        // chunks.js's /chunks and /stats routes cache a scan of this save's
        // map/ folder for a few seconds (see getMapFolderScan()'s comment).
        // This wipe just deleted it out from under that cache -- without
        // this, a page reload within the TTL window would show chunk counts
        // for a map/ folder that no longer exists.
        invalidateMapFolderScan(path.join(saveDir, "map"));
      }

      if (targets.includes("players")) {
        let deletedCount = 0;
        // No inner try/catch here (bug hunt 2026-08-31): a throw must reach
        // the outer catch below, same as map/leftovers/accounts already do,
        // so a real unlink failure (e.g. a lingering AV/backup file lock
        // right after the pre-wipe stop) produces an honest
        // WIPE_PARTIAL_FAILURE instead of being swallowed into the same
        // "not found" string a genuinely-empty directory reports -- those
        // two outcomes must not look identical to the caller.
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && PLAYER_ROOT_FILES.test(entry.name)) {
            log.warn(`WIPE: Deleting player file ${entry.name}`);
            fs.unlinkSync(path.join(saveDir, entry.name));
            deletedCount++;
          }
        }
        results.players =
          deletedCount > 0 ? `deleted ${deletedCount} files` : "not found";
      }

      if (targets.includes("world")) {
        let deletedCount = 0;
        // Delete world directories
        for (const dirName of WORLD_DIRS) {
          const dir = path.join(saveDir, dirName);
          if (fs.existsSync(dir)) {
            log.warn(`WIPE: Deleting ${dirName}/ at ${dir}`);
            fs.rmSync(dir, { recursive: true, force: true });
            deletedCount++;
          }
        }
        // Delete world root files. Same no-inner-catch reasoning as the
        // players block above.
        const rootEntries = fs.readdirSync(saveDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory() && WORLD_ROOT_FILES.test(entry.name)) {
            log.warn(`WIPE: Deleting world file ${entry.name}`);
            fs.unlinkSync(path.join(saveDir, entry.name));
            deletedCount++;
          }
        }
        results.world =
          deletedCount > 0 ? `deleted ${deletedCount} items` : "not found";
      }

      // Selecting every target means a total wipe: remove whatever the
      // per-target lists don't recognise so nothing from the old world survives.
      if (SAVE_TARGETS.every((t) => targets.includes(t))) {
        let leftovers = 0;
        for (const entry of fs.readdirSync(saveDir, { withFileTypes: true })) {
          log.warn(`WIPE: Deleting leftover ${entry.name}`);
          fs.rmSync(path.join(saveDir, entry.name), {
            recursive: true,
            force: true,
          });
          leftovers++;
        }
        results.leftovers =
          leftovers > 0 ? `deleted ${leftovers} remaining items` : "none";
      }

      if (targets.includes("accounts")) {
        let deletedCount = 0;
        for (const suffix of ["", "-journal", "-wal", "-shm"]) {
          const dbFile = path.join(savePath, "db", `${serverName}.db${suffix}`);
          if (fs.existsSync(dbFile)) {
            log.warn(`WIPE: Deleting account database ${dbFile}`);
            fs.rmSync(dbFile, { force: true });
            deletedCount++;
          }
        }
        results.accounts =
          deletedCount > 0 ? `deleted ${deletedCount} files` : "not found";
      }
    } finally {
      wipeInProgress = false;
    }

    log.warn(
      `WIPE COMPLETE: server=${serverName}, targets=${targets.join(",")}, results=${JSON.stringify(results)}`,
    );
    await logServerEventBestEffort("wipe", `Server wiped: ${targets.join(", ")}`, {
      targets,
      results,
    });

    res.json({
      success: true,
      serverName,
      targets,
      results,
      backupCreated: !!backupResult?.success,
      backupName: backupResult?.backup?.name || null,
      message: `Server "${serverName}" wiped: ${targets.join(", ")}`,
    });
  } catch (error) {
    log.error(`Wipe failed: ${error.message}`);
    // 2026-08-26, partial-failure-state hunt: `results` may already hold
    // completed targets from before this throw (map/leftovers/accounts
    // deletion isn't individually try/caught the way players/world's
    // root-file loops are) -- a bare {error} here told the operator
    // neither what actually got deleted nor that a pre-wipe backup exists
    // to fall back to. Both are already in scope from earlier in this
    // handler; surfacing them costs nothing and answers the two questions
    // that actually matter after a failed destructive operation.
    log.warn(`WIPE PARTIAL: server=${serverName || "unknown"}, results=${JSON.stringify(results)}`);
    await logServerEventBestEffort(
      "wipe",
      `Server wipe FAILED partway through: ${error.message}`,
      { targets, results, error: error.message },
    );
    res.status(500).json({
      error: `Wipe failed partway through (${sanitizeError(error.message)}). Some of the selected targets may be only partially deleted -- check the results for what completed before the failure.`,
      code: ErrorCode.WIPE_PARTIAL_FAILURE,
      params: { reason: sanitizeError(error.message) },
      results,
      backupCreated: !!backupResult?.success,
      backupName: backupResult?.backup?.name || null,
    });
  } finally {
    wipeInProgress = false;
    lifecycleLock.release();
  }
});

export default router;
