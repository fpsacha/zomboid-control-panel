// Docker mount auto-discovery endpoints. Mounted at the same base path as
// routes/servers.js (/api/servers) but registered first in index.js so these
// literal paths are matched before servers.js's GET /:id catch-all.
import express from "express";
import path from "path";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Discovery");
import { sanitizeError, sanitizeServerResponse } from "../utils/sanitize.js";
import { normalizeRconHost } from "../services/rcon.js";
import { createServer } from "../database/init.js";
import { requirePermission } from "../services/permissions.js";
import {
  discoverMounts,
  discoverMountIssues,
  scanAllCandidates,
  probeInstallPath,
  probeDataPath,
  readServerIniSettings,
} from "../services/mountDiscovery.js";

const router = express.Router();
const SERVER_NAME_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9_ -]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/;

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// GET /api/servers/discover-mounts — probe common bind-mount locations for
// PZ server files so Settings can offer a one-click "connect this" profile.
router.get("/discover-mounts", requirePermission("servers.discover"), async (req, res) => {
  try {
    // inaccessible: candidates that exist but couldn't be read (permission
    // denied) rather than simply not being mounted -- surfaced separately so
    // a misconfigured host permission doesn't read identically to "nothing
    // mounted here". Kept unchanged for every existing caller (DiscoverySetup.tsx).
    //
    // candidates: server-detection-lifecycle-hardening, 2026-09-09 -- the
    // additive, ranked-with-reasons version. `mounts`/`inaccessible` above
    // only ever show a candidate once it's fully ready or explicitly
    // permission-denied; everything else (empty, not mounted, half-there)
    // was invisible. `candidates` shows EVERY common Docker/Unraid/env
    // location this scan knows about, ranked best-first, each with a
    // `status` and a plain-language `reason` -- see
    // mountDiscovery.js's scanAllCandidates() for the taxonomy. New UI
    // should read this field; DiscoverySetup.tsx's existing flow is
    // untouched.
    res.json({
      mounts: discoverMounts(),
      inaccessible: discoverMountIssues(),
      candidates: scanAllCandidates(),
    });
  } catch (error) {
    log.error(`Mount discovery failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// POST /api/servers/create-from-discovery — turn a discover-mounts result
// into a fully-populated local server profile, reading RCON settings from
// the discovered server's own INI instead of asking the user to retype them.
router.post("/create-from-discovery", requirePermission("servers.discover"), async (req, res) => {
  try {
    const { installPath, dataPath, serverName, name } = req.body || {};
    if (
      typeof installPath !== "string" ||
      typeof dataPath !== "string" ||
      !installPath ||
      !dataPath
    ) {
      return res
        .status(400)
        .json({ error: "installPath and dataPath are required" });
    }

    const discovered = discoverMounts().find(
      (mount) =>
        normalizePath(mount.installPath) === normalizePath(installPath) &&
        normalizePath(mount.dataPath) === normalizePath(dataPath),
    );
    if (!discovered) {
      return res.status(400).json({ error: "Mount is not a discovered PZ server" });
    }

    const installResult = probeInstallPath(discovered.installPath);
    if (!installResult.valid) {
      return res
        .status(400)
        .json({ error: "installPath does not look like a PZ server install" });
    }

    const dataResult = probeDataPath(discovered.dataPath);
    if (!dataResult.valid) {
      return res
        .status(400)
        .json({ error: "dataPath does not look like a PZ data folder" });
    }

    const resolvedName =
      serverName || dataResult.serverNames[0] || installResult.serverNames[0];
    if (!resolvedName) {
      return res.status(400).json({
        error: "No server config (Server/*.ini) found — specify serverName",
      });
    }
    if (!SERVER_NAME_RE.test(resolvedName)) {
      return res.status(400).json({ error: "Invalid serverName" });
    }
    if (
      discovered.serverNames.length > 0 &&
      !discovered.serverNames.includes(resolvedName)
    ) {
      return res.status(400).json({ error: "Server is not part of this mount" });
    }

    const iniSettings = readServerIniSettings(discovered.dataPath, resolvedName);
    if (!iniSettings) {
      return res.status(400).json({
        error: `Could not read valid RCON or game port settings from ${resolvedName}.ini — fix the file, then retry.`,
      });
    }
    if (!iniSettings.rconPassword) {
      return res.status(400).json({
        error: `RCON password not set in ${resolvedName}.ini — set RCONPassword on the server, then retry.`,
      });
    }

    // docker-unraid-onboarding, 2026-09-09: found by Dwight tracing this
    // route end to end. This USED to always hardcode 127.0.0.1 -- correct
    // for the co-located, single-container topology (PZ and the panel in
    // the same container, or PZ native on the same host), but the
    // project's own docker/unraid/zomboid-panel.xml documents a SECOND,
    // equally real topology: the panel and PZ in TWO SEPARATE containers
    // sharing only the bind-mounted install/data volumes, reachable over
    // the Docker network -- and that template's own RCON_HOST field says,
    // verbatim, "Never use 127.0.0.1." Discovery finds the install, the
    // data, the INI, and reads the real RCON port/password out of it --
    // then created a profile that could never connect, on the one field
    // nothing else derives. rcon.js's own env fallback
    // (`process.env.RCON_HOST || "127.0.0.1"`) is the established
    // convention for exactly this case; reused here rather than inventing
    // a second one. "CHANGE_ME" is the template's own literal default for
    // a REQUIRED field -- guarded explicitly in case an Unraid version
    // ever lets a required field deploy unedited, so a profile is never
    // created pointed at a host literally named "CHANGE_ME".
    const envRconHost = String(process.env.RCON_HOST || "").trim();
    const resolvedRconHost =
      envRconHost && envRconHost !== "CHANGE_ME" ? envRconHost : "127.0.0.1";

    const server = await createServer({
      name: name || iniSettings.publicName || resolvedName,
      serverName: resolvedName,
      installPath: discovered.installPath,
      zomboidDataPath: discovered.dataPath,
      rconHost: normalizeRconHost(resolvedRconHost),
      rconPort: iniSettings.rconPort,
      rconPassword: iniSettings.rconPassword,
      serverPort: iniSettings.serverPort,
      isRemote: false,
    });

    log.info(
      `Created server from discovered mount: ${server.name} (ID: ${server.id})`,
    );
    res
      .status(201)
      .json({
        server: sanitizeServerResponse(server),
        message: "Server created from discovered mount",
      });
  } catch (error) {
    log.error(`create-from-discovery failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
