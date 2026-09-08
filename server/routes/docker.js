import express from "express";
import { requirePermission } from "../services/permissions.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { getServer } from "../database/init.js";
import { RconService } from "../services/rcon.js";
import { ErrorCode } from "../utils/errorCodes.js";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.js";
import { resolveDockerHostSignal } from "../services/managedContainer.js";

const router = express.Router();

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

router.get("/status", requirePermission("docker.manage"), async (req, res) => {
  try {
    const dockerClient = req.app.get("dockerClient");
    if (!dockerClient?.enabled) {
      return res.json({ enabled: false, available: false, containers: [] });
    }
    const containers = await dockerClient.listManagedContainers();
    return res.json({
      enabled: true,
      available: dockerClient.available,
      // An unreadable socket looks exactly like "no managed containers" without
      // this: `available` only proves the socket file exists.
      ...(dockerClient.lastError ? { error: sanitizeError(dockerClient.lastError) } : {}),
      containers: containers.map((container) => ({
        id: container.Id,
        name: (container.Names?.[0] || "").replace(/^\//, ""),
        image: container.Image,
        state: container.State,
        status: container.Status,
      })),
    });
  } catch (error) {
    return res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/stats", requirePermission("docker.manage"), async (req, res) => {
  try {
    const dockerClient = req.app.get("dockerClient");
    if (!dockerClient?.enabled || !dockerClient.available) return res.json({ containers: {} });
    const containers = await dockerClient.listManagedContainers();
    const samples = await mapWithConcurrency(containers, 3, async (container) => ({
      container,
      stats: await dockerClient.getContainerStats(container.Id),
    }));
    const result = {};
    for (const { container, stats } of samples) {
      if (!stats) continue;
      result[container.Id] = stats;
      const name = (container.Names?.[0] || "").replace(/^\//, "");
      if (name) result[name] = stats;
    }
    return res.json({ containers: result });
  } catch (error) {
    return res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/containers/:id/:action", requirePermission("docker.manage"), async (req, res) => {
  const lifecycleLock = acquireLifecycleLock(
    `docker-${req.params.action}`,
    req.params.id || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  let rconService = null;
  try {
    const dockerClient = req.app.get("dockerClient");
    if (!dockerClient?.enabled || !dockerClient.available) {
      return res.status(503).json({
        error: "Docker control is unavailable",
        code: ErrorCode.DOCKER_UNAVAILABLE,
      });
    }
    const server = await getServer(req.body?.serverId);
    if (!server) {
      return res.status(404).json({
        error: "Server profile not found",
        code: ErrorCode.SERVER_PROFILE_NOT_FOUND,
      });
    }
    if (
      server.dockerContainerName !== req.params.id &&
      server.dockerContainerId !== req.params.id
    ) {
      return res.status(403).json({
        error: "Container is not mapped to this server",
        code: ErrorCode.CONTAINER_NOT_MAPPED,
      });
    }
    // wrapper-bypass class sweep, 2026-09-08: this used to call
    // dockerClient.inspectManagedContainer() directly and treat any null
    // result as "not managed" -- but that raw call collapses a genuine
    // "exists, unlabeled" answer and a transient Docker API failure into the
    // exact same null. Routed through resolveDockerHostSignal() (the same
    // wrapper serverStatus.js's dashboard badge and index.js's watchdog
    // already use) so a daemon hiccup reads as scanFailed, not a confident
    // "not managed" -- those are different operator actions (retry/check the
    // daemon vs. fix the mapping) and conflating them sent an operator to
    // re-map a container that was never broken.
    const dockerSignal = await resolveDockerHostSignal(server, dockerClient);
    if (dockerSignal.scanFailed) {
      // dockerClient.lastError is set by inspectManagedContainer() (called
      // internally by resolveDockerHostSignal above) only when the request
      // itself failed to complete -- cleared on any call that actually
      // reached the daemon, labeled or not. Read immediately, before any
      // other await, since it's a field shared with other Docker calls.
      if (dockerClient.lastError) {
        return res.status(503).json({
          success: false,
          error: `Can't verify the container's state — the Docker API call itself failed: ${sanitizeError(dockerClient.lastError)}. Check that the Docker daemon is reachable and try again.`,
          code: ErrorCode.SERVER_STATE_UNKNOWN,
        });
      }
      return res.status(403).json({
        error: "Container is not managed by this panel",
        code: ErrorCode.CONTAINER_NOT_MANAGED,
      });
    }
    if (["stop", "restart"].includes(req.params.action) && dockerSignal.running) {
      rconService = new RconService();
      await rconService.loadConfig(server.id);
      if (!(await rconService.connect())) {
        return res.status(409).json({
          error: "RCON connection failed; container was not changed",
          code: ErrorCode.DOCKER_ACTION_RCON_CONNECT_FAILED,
        });
      }
      const saved = await rconService.save({ skipLog: true });
      if (!saved?.success) {
        const reason = saved?.error || "unknown error";
        return res.status(409).json({
          error: `World save failed: ${reason}`,
          code: ErrorCode.DOCKER_ACTION_SAVE_FAILED,
          params: sanitizeErrorParams({ reason }),
        });
      }
    }
    const result = await dockerClient.runManagedAction(req.params.id, req.params.action);
    if (!result.success) {
      // Same redaction the /status route above already applies to this
      // client's errors -- runManagedAction now returns the real Docker
      // error text (was a static "Docker action failed" for every cause),
      // which can include a filesystem path (e.g. a socket permission error).
      return res.status(403).json({ ...result, error: sanitizeError(result.error) });
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    if (rconService?.connected) {
      await rconService.disconnect().catch(() => {});
    }
    lifecycleLock.release();
  }
});

export default router;
