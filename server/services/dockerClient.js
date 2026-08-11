import fs from "fs";
import http from "http";
import { createLogger } from "../utils/logger.js";

const log = createLogger("DockerClient");
const MANAGED_LABEL = "zomboid-panel.managed";
const REQUEST_TIMEOUT_MS = 5000;
// Lifecycle calls block until Docker finishes. `POST /containers/{id}/stop`
// waits out the container's own StopTimeout (Compose's `stop_grace_period`,
// which a modded B42 world sets to 90s or more) before it answers, so the 5s
// read timeout would abort the socket and report a failure on every successful
// stop. Budget the container's shutdown window plus room for the daemon.
const LIFECYCLE_GRACE_MS = 30000;
const DEFAULT_STOP_TIMEOUT_SEC = 10;

export function isManagedContainer(container) {
  const labels = container?.Labels || container?.Config?.Labels;
  return labels?.[MANAGED_LABEL] === "true";
}

function cpuCount(stats) {
  return stats?.cpu_stats?.online_cpus || stats?.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
}

function sumEntries(entries, operation) {
  return (entries || [])
    .filter((entry) => entry.op?.toLowerCase() === operation)
    .reduce((sum, entry) => sum + (entry.value || 0), 0);
}

function sumNetwork(networks, field) {
  return Object.values(networks || {}).reduce(
    (sum, network) => sum + (network[field] || 0),
    0,
  );
}

export function parseContainerStats(stats) {
  const cpuDelta = (stats?.cpu_stats?.cpu_usage?.total_usage || 0) -
    (stats?.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = (stats?.cpu_stats?.system_cpu_usage || 0) -
    (stats?.precpu_stats?.system_cpu_usage || 0);
  const cores = cpuCount(stats);
  const memoryUsed = stats?.memory_stats?.usage || 0;
  const memoryLimit = stats?.memory_stats?.limit || 0;
  return {
    cpuPercent: systemDelta > 0 && cpuDelta > 0
      ? Math.round((cpuDelta / systemDelta) * cores * 1000) / 10
      : 0,
    memoryUsed,
    memoryLimit,
    memoryPercent: memoryLimit > 0
      ? Math.round((memoryUsed / memoryLimit) * 1000) / 10
      : 0,
    networkRx: sumNetwork(stats?.networks, "rx_bytes"),
    networkTx: sumNetwork(stats?.networks, "tx_bytes"),
    diskRead: sumEntries(stats?.blkio_stats?.io_service_bytes_recursive, "read"),
    diskWrite: sumEntries(stats?.blkio_stats?.io_service_bytes_recursive, "write"),
  };
}

/**
 * How long to hold the socket open for a lifecycle action. Docker answers only
 * once the action completes, and a stop waits out the container's configured
 * StopTimeout before escalating to SIGKILL. A restart pays that cost and then
 * starts the container again.
 */
export function lifecycleTimeoutMs(action, container) {
  if (action === "start") return LIFECYCLE_GRACE_MS;
  const configured = Number(container?.Config?.StopTimeout);
  const stopTimeoutSec = configured > 0 ? configured : DEFAULT_STOP_TIMEOUT_SEC;
  const grace = action === "restart" ? LIFECYCLE_GRACE_MS * 2 : LIFECYCLE_GRACE_MS;
  return stopTimeoutSec * 1000 + grace;
}

export class DockerClient {
  constructor({ socketPath = "/var/run/docker.sock", enabled = process.env.PANEL_DOCKER_CONTROL_ENABLED === "true" } = {}) {
    this.socketPath = socketPath;
    this.enabled = enabled;
    // Last discovery failure, surfaced through /api/docker/status. `available`
    // is only an existsSync check, so a socket the panel can stat but not open
    // (root:docker 0660 vs. a non-root panel user) otherwise looks identical to
    // "no managed containers exist".
    this.lastError = null;
  }

  get available() {
    return this.enabled && fs.existsSync(this.socketPath);
  }

  async listManagedContainers() {
    if (!this.available) return [];
    try {
      const containers = await this._requestJson("GET", "/containers/json?all=true");
      this.lastError = null;
      return Array.isArray(containers) ? containers.filter(isManagedContainer) : [];
    } catch (error) {
      this.lastError = error.message;
      log.warn(
        `Docker discovery failed: ${error.message}. The panel can see ${this.socketPath} but cannot query it — check that its user is in the socket's group.`,
      );
      return [];
    }
  }

  async inspectManagedContainer(containerId) {
    if (!this.available) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerId)) return null;
    try {
      const container = await this._requestJson(
        "GET",
        `/containers/${encodeURIComponent(containerId)}/json`,
      );
      return isManagedContainer(container) ? container : null;
    } catch {
      return null;
    }
  }

  async runManagedAction(containerId, action) {
    if (!this.available) return { success: false, error: "Docker control is unavailable" };
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerId)) {
      return { success: false, error: "Invalid container identifier" };
    }
    if (!["start", "stop", "restart"].includes(action)) {
      return { success: false, error: "Invalid container action" };
    }

    try {
      const container = await this.inspectManagedContainer(containerId);
      if (!container) {
        return { success: false, error: "Container is not managed by this panel" };
      }
      const statusCode = await this._requestStatus(
        "POST",
        `/containers/${encodeURIComponent(containerId)}/${action}`,
        lifecycleTimeoutMs(action, container),
      );
      if (statusCode === 304) return { success: true, message: "Container is already in the requested state" };
      if (statusCode >= 200 && statusCode < 300) return { success: true };
      return { success: false, error: `Docker API returned ${statusCode}` };
    } catch (error) {
      log.warn(`Docker ${action} failed for ${containerId}: ${error.message}`);
      return { success: false, error: "Docker action failed" };
    }
  }

  async getContainerStats(containerId) {
    if (!this.available) return null;
    try {
      const raw = await this._requestJson(
        "GET",
        `/containers/${encodeURIComponent(containerId)}/stats?stream=false`,
      );
      return parseContainerStats(raw);
    } catch (error) {
      log.debug(`Docker stats failed for ${containerId}: ${error.message}`);
      return null;
    }
  }

  _requestJson(method, requestPath, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath: this.socketPath, method, path: requestPath, timeout: timeoutMs },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            if (response.statusCode >= 400) {
              reject(new Error(`Docker API returned ${response.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
            } catch {
              reject(new Error("Docker API returned invalid JSON"));
            }
          });
        },
      );
      request.on("timeout", () => request.destroy(new Error("Docker API timed out")));
      request.on("error", reject);
      request.end();
    });
  }

  _requestStatus(method, requestPath, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath: this.socketPath, method, path: requestPath, timeout: timeoutMs },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("timeout", () => request.destroy(new Error("Docker API timed out")));
      request.on("error", reject);
      request.end();
    });
  }
}
