import { spawn as nodeSpawn } from "child_process";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { untrustedFolderReason } from "../utils/untrustedFolder.js";
import { getSetting } from "../database/init.js";
import {
  getActiveSteamOperations,
  hasActiveSteamOperation,
  clearActiveSteamOperation,
  recordActiveSteamOperationPid,
  WORKSHOP_DOWNLOAD_OPERATION_TYPE,
} from "./activeSteamOperations.js";

const log = createLogger("WorkshopDownload");

// Project Zomboid's Steam app id: Workshop items live under app 108600, not the
// dedicated server's own 380870.
const PZ_WORKSHOP_APP_ID = "108600";
export const WORKSHOP_DOWNLOAD_TIMEOUT_MS = 8 * 60 * 1000;
const OUTPUT_CAP = 64 * 1024;

export const WorkshopDownloadReason = Object.freeze({
  INVALID_ID: "invalid-id",
  NO_SERVER_PATH: "no-server-path",
  STEAMCMD_NOT_CONFIGURED: "steamcmd-not-configured",
  STEAMCMD_NOT_FOUND: "steamcmd-not-found",
  STEAM_OPERATION_ACTIVE: "steam-operation-active",
  FAILED: "failed",
  TIMEOUT: "timeout",
  ABORTED: "aborted",
});

function steamCmdExecutable(steamcmdPath) {
  // Never from a Workshop download folder or a network share (routes/server.js's
  // steamCmdFolderRefusal()): a folder saved before that check counts as missing.
  if (untrustedFolderReason(steamcmdPath)) return null;
  const isWindows = process.platform === "win32";
  const primary = path.join(steamcmdPath, isWindows ? "steamcmd.exe" : "steamcmd.sh");
  if (fs.existsSync(primary)) return primary;
  if (!isWindows) {
    const plain = path.join(steamcmdPath, "steamcmd");
    if (fs.existsSync(plain)) return plain;
    for (const system of ["/usr/games/steamcmd", "/usr/bin/steamcmd", "/usr/local/bin/steamcmd"]) {
      if (fs.existsSync(system)) return system;
    }
  }
  return null;
}

function itemFolderHasFiles(serverPath, workshopId) {
  try {
    const folder = path.join(serverPath, "steamapps", "workshop", "content", PZ_WORKSHOP_APP_ID, workshopId);
    return fs.readdirSync(folder).length > 0;
  } catch {
    return false;
  }
}

// What SteamCMD says when it is done: "Success. Downloaded item <id> to ..." or
// "ERROR! Download item <id> failed (<reason>)."
export function parseWorkshopDownloadOutput(output, workshopId) {
  const text = String(output || "");
  const success = new RegExp(`Success\\.\\s+Downloaded item\\s+${workshopId}\\b`, "i").test(text);
  if (success) return { success: true };
  const failure = new RegExp(`Download item\\s+${workshopId}\\s+failed\\s*\\(([^)]*)\\)`, "i").exec(text);
  return { success: false, detail: failure ? failure[1].trim() : null };
}

/**
 * Downloads one Workshop item into `<serverPath>/steamapps/workshop/content/108600/<id>`
 * with the SteamCMD the panel already has saved (anonymous login), so its mod.info
 * files can be read before the server ever starts: a mod added by URL whose mod IDs
 * Steam's description does not state was added to WorkshopItems= only, the server
 * downloaded it on the next boot after it had already read Mods=, and the mod was
 * never enabled. The server skips what is already downloaded and current.
 *
 * Never throws: { success, reason, error }.
 */
export async function downloadWorkshopItem(
  workshopId,
  {
    serverPath,
    timeoutMs = WORKSHOP_DOWNLOAD_TIMEOUT_MS,
    signal,
    spawn = nodeSpawn,
    readSetting = getSetting,
    buildEnv = null,
  } = {},
) {
  const id = String(workshopId ?? "");
  if (!/^\d{1,15}$/.test(id)) {
    return { success: false, reason: WorkshopDownloadReason.INVALID_ID, error: "Invalid Workshop ID" };
  }
  if (!serverPath || !path.isAbsolute(serverPath) || !fs.existsSync(serverPath)) {
    return {
      success: false,
      reason: WorkshopDownloadReason.NO_SERVER_PATH,
      error: "The server install folder is not set or does not exist",
    };
  }

  // The executable comes only from the saved steamcmdPath setting, never from a
  // request (see routes/server.js: no SteamCMD spawn from a caller-chosen path).
  const steamcmdPath = await readSetting("steamcmdPath");
  if (!steamcmdPath || typeof steamcmdPath !== "string") {
    return { success: false, reason: WorkshopDownloadReason.STEAMCMD_NOT_CONFIGURED, error: "SteamCMD is not configured" };
  }
  const exe = steamCmdExecutable(steamcmdPath);
  if (!exe) {
    return { success: false, reason: WorkshopDownloadReason.STEAMCMD_NOT_FOUND, error: "SteamCMD was not found" };
  }

  const normalizedPath = path.normalize(serverPath).toLowerCase();
  if (hasActiveSteamOperation(normalizedPath)) {
    return {
      success: false,
      reason: WorkshopDownloadReason.STEAM_OPERATION_ACTIVE,
      error: "A SteamCMD install or update is running for this server",
    };
  }
  getActiveSteamOperations().set(normalizedPath, {
    // Does not block a server start (hasStartBlockingSteamOperation()).
    type: WORKSHOP_DOWNLOAD_OPERATION_TYPE,
    startTime: Date.now(),
    lastOutputAt: Date.now(),
  });

  const args = [
    "+force_install_dir",
    serverPath,
    "+login",
    "anonymous",
    "+workshop_download_item",
    PZ_WORKSHOP_APP_ID,
    id,
    "+quit",
  ];
  const options = { cwd: steamcmdPath, windowsHide: true };
  if (typeof buildEnv === "function") options.env = buildEnv(steamcmdPath);

  try {
    return await new Promise((resolve) => {
      let output = "";
      let settled = false;
      let child;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        resolve(result);
      };
      // The result is settled first: killing the child makes it emit "close", which
      // must not be read as a failed download.
      const killChild = () => {
        try {
          child?.kill();
        } catch {
          /* already gone */
        }
      };
      const onAbort = () => {
        finish({ success: false, reason: WorkshopDownloadReason.ABORTED, error: "Download cancelled" });
        killChild();
      };
      const timer = setTimeout(() => {
        finish({
          success: false,
          reason: WorkshopDownloadReason.TIMEOUT,
          error: `SteamCMD did not finish within ${Math.round(timeoutMs / 1000)} s`,
        });
        killChild();
      }, timeoutMs);
      timer.unref?.();

      if (signal?.aborted) return onAbort();
      signal?.addEventListener?.("abort", onAbort, { once: true });

      try {
        child = spawn(exe, args, options);
      } catch (error) {
        return finish({ success: false, reason: WorkshopDownloadReason.FAILED, error: error.message });
      }
      if (Number.isInteger(child?.pid)) {
        void recordActiveSteamOperationPid(normalizedPath, child.pid);
      }

      const collect = (chunk) => {
        const operation = getActiveSteamOperations().get(normalizedPath);
        if (operation) operation.lastOutputAt = Date.now();
        output = (output + chunk.toString()).slice(-OUTPUT_CAP);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", (error) => {
        finish({ success: false, reason: WorkshopDownloadReason.FAILED, error: error.message });
      });
      child.on("close", (code) => {
        const parsed = parseWorkshopDownloadOutput(output, id);
        if (parsed.success) {
          log.info(`Downloaded Workshop item ${id} with SteamCMD`);
          return finish({ success: true });
        }
        // SteamCMD that updates itself first relaunches and can end without the
        // success line in what this process saw: the files on disk are the answer.
        if (!parsed.detail && itemFolderHasFiles(serverPath, id)) {
          log.info(`Workshop item ${id} is on disk after SteamCMD ended without a success line`);
          return finish({ success: true });
        }
        const detail = parsed.detail ? ` (${parsed.detail})` : "";
        log.warn(`SteamCMD could not download Workshop item ${id}${detail}; exit code ${code}`);
        finish({
          success: false,
          reason: WorkshopDownloadReason.FAILED,
          error: `SteamCMD could not download the item${detail}`,
        });
      });
    });
  } finally {
    clearActiveSteamOperation(normalizedPath);
  }
}
