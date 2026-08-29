// Composed, provider-aware status for the active server: host (process /
// container / remote reachability), RCON, and PanelBridge as three
// independent signals instead of one ambiguous "running" flag. See
// server/utils/serverStatusModel.js for the composition logic.
import express from "express";
import { createLogger } from "../utils/logger.js";
import { sanitizeError } from "../utils/sanitize.js";
import { getActiveServer } from "../database/init.js";
import panelBridge from "../services/panelBridge.js";
import { composeServerStatus, resolveProvider } from "../utils/serverStatusModel.js";
import { resolveManagedContainer } from "../services/managedContainer.js";

const log = createLogger("API:ServerStatus");
const router = express.Router();

// No requireRole, deliberately: every role needs to know whether the
// server is up before doing anything else with it (a moderator deciding
// whether to even attempt an in-game action, a technician deciding whether
// to restart it). Read-only, nothing sensitive returned.
router.get("/active/status", async (req, res) => {
  try {
    const server = await getActiveServer();
    if (!server) {
      return res.status(404).json({ error: "No active server configured" });
    }

    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");
    const rconConfig = rconService?.getConfig ? rconService.getConfig() : {};

    const provider = resolveProvider(server);
    const isContainerProvider =
      provider === "docker-local" || provider === "docker-managed";

    // A fresh check, not serverManager.isRunning -- that cached field is
    // forced to a confident `false` by ANY failed process-detection scan,
    // so reading it directly here made this endpoint (which feeds the
    // dashboard's host badge) disagree with /wipe's own fresh scanFailed
    // check on the exact same host, at the exact same moment. See
    // server/utils/serverStatusModel.js's buildHostSignal for how scanFailed
    // renders as "unknown" instead of a wrong "stopped".
    let processDetails;
    let dockerContainer = null;
    if (isContainerProvider) {
      const containerRef = server.dockerContainerName || server.dockerContainerId;
      let container = null;
      const dockerClient = req.app.get("dockerClient");
      if (containerRef && dockerClient?.enabled && dockerClient.available &&
          typeof dockerClient.inspectManagedContainer === "function") {
        container = await dockerClient.inspectManagedContainer(containerRef);
        processDetails = container
          ? { running: container.State?.Running === true, scanFailed: false }
          : { running: false, scanFailed: true };
        dockerContainer = container
          ? { handled: true, running: processDetails.running }
          : { handled: true, error: "Docker container status unavailable" };
      } else {
        const managed = await resolveManagedContainer({
          serverId: server.id,
          dockerClient,
        });
        if (managed.handled) {
          processDetails = managed.error
            ? { running: false, scanFailed: true }
            : { running: managed.running === true, scanFailed: false };
          dockerContainer = managed;
        }
      }
      if (!processDetails) processDetails = { running: false, scanFailed: true };
    } else {
      processDetails = typeof serverManager?.getServerProcessDetails === "function"
        ? await serverManager.getServerProcessDetails()
        : { running: !!serverManager?.isRunning, scanFailed: false };
    }

    // GH#114: PZ in this provider runs as PID 1 of a *different* container,
    // so the local process scan above can never see it -- it's asked for
    // regardless (serverManager still needs it for native servers) but for
    // docker-local/docker-managed the host signal must come from the
    // managed container's own state instead, never the scan. See
    // buildHostSignal in serverStatusModel.js for the fail-closed handling
    // when Docker control is disabled/unavailable or the mapping is broken.
    const status = composeServerStatus({
      server,
      isRunning: !!processDetails.running,
      scanFailed: !!processDetails.scanFailed,
      dockerContainer,
      rcon: {
        ...rconConfig,
        connecting: !!(rconService?.connecting || rconService?.reconnecting),
      },
      bridge: {
        configured: !!panelBridge.bridgePath,
        running: !!panelBridge.isRunning,
        modConnected: panelBridge.isModConnected ? panelBridge.isModConnected() : false,
      },
    });

    res.json(status);
  } catch (error) {
    log.error(`Failed to get composed server status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
