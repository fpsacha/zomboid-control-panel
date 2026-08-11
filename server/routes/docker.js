import express from "express";
import { requireRole } from "../services/auth.js";
import { sanitizeError } from "../utils/sanitize.js";
import { getServer } from "../database/init.js";
import { RconService } from "../services/rcon.js";

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

router.get("/status", requireRole("admin"), async (req, res) => {
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

router.get("/stats", requireRole("admin"), async (req, res) => {
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

router.post("/containers/:id/:action", requireRole("admin"), async (req, res) => {
  let rconService = null;
  try {
    const dockerClient = req.app.get("dockerClient");
    if (!dockerClient?.enabled || !dockerClient.available) {
      return res.status(503).json({ error: "Docker control is unavailable" });
    }
    const server = await getServer(req.body?.serverId);
    if (!server) return res.status(404).json({ error: "Server profile not found" });
    if (
      server.dockerContainerName !== req.params.id &&
      server.dockerContainerId !== req.params.id
    ) {
      return res.status(403).json({ error: "Container is not mapped to this server" });
    }
    const container = await dockerClient.inspectManagedContainer(req.params.id);
    if (!container) {
      return res.status(403).json({ error: "Container is not managed by this panel" });
    }
    if (["stop", "restart"].includes(req.params.action) && container.State?.Running) {
      rconService = new RconService();
      await rconService.loadConfig(server.id);
      if (!(await rconService.connect())) {
        return res.status(409).json({ error: "RCON connection failed; container was not changed" });
      }
      const saved = await rconService.save({ skipLog: true });
      if (!saved?.success) {
        return res.status(409).json({ error: `World save failed: ${saved?.error || "unknown error"}` });
      }
    }
    const result = await dockerClient.runManagedAction(req.params.id, req.params.action);
    if (!result.success) return res.status(403).json(result);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: sanitizeError(error.message) });
  } finally {
    if (rconService?.connected) {
      await rconService.disconnect().catch(() => {});
    }
  }
});

export default router;
