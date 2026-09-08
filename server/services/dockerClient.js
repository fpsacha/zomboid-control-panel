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
const DEFAULT_LOG_TAIL_LINES = 500;
// Defense in depth under `tail=`: Docker bounds the request by LINE count,
// not byte count, so one pathological line (a huge unbroken stack trace, or
// binary-looking output) could still balloon the response. This is a hard
// ceiling that only ever engages if that happens.
const MAX_LOG_RESPONSE_BYTES = 4 * 1024 * 1024;

export function isManagedContainer(container) {
  const labels = container?.Labels || container?.Config?.Labels;
  return labels?.[MANAGED_LABEL] === "true";
}

/**
 * A container created WITHOUT an allocated TTY (the normal case for
 * `docker run -d` / Compose, i.e. every managed container this panel deals
 * with day to day) has its `/logs` response multiplexed: each frame is an
 * 8-byte header (1 byte stream type, 3 reserved, 4-byte big-endian payload
 * length) followed by that many payload bytes. A TTY container's response
 * has no such framing and is already plain text -- callers must check
 * `container.Config?.Tty` themselves before deciding whether to call this.
 * https://docs.docker.com/engine/api/v1.41/#tag/Container/operation/ContainerLogs
 */
export function demuxDockerLogStream(buffer) {
  const parts = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break; // truncated final frame -- stop cleanly, keep what parsed
    parts.push(buffer.subarray(start, end));
    offset = end;
  }
  return Buffer.concat(parts).toString("utf-8");
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

  // Sets `lastError` the same way listManagedContainers() already does --
  // cleared on a call that actually reached the daemon (whether or not the
  // container turned out to be labeled), set on one that didn't. A null
  // return is otherwise ambiguous between "asked, and it's confirmed not
  // ours" (unlabeled, or a genuine 404) and "couldn't ask" (socket
  // unreachable, timeout, malformed response) -- callers that need to tell
  // those apart (server/routes/docker.js's POST /containers/:id/:action)
  // read this field immediately after, before any other await, to avoid
  // another concurrent Docker call overwriting it first.
  async inspectManagedContainer(containerId) {
    if (!this.available) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerId)) return null;
    try {
      const container = await this._requestJson(
        "GET",
        `/containers/${encodeURIComponent(containerId)}/json`,
      );
      this.lastError = null;
      return isManagedContainer(container) ? container : null;
    } catch (error) {
      this.lastError = error.message;
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
      // listManagedContainers() already does this (see this.lastError above) --
      // this was the one method in the file still collapsing every cause (an
      // unreachable socket, a permission-denied socket, a timed-out stop) into
      // one static string, so a slow daemon and a broken socket looked identical.
      return { success: false, error: error.message || "Docker action failed" };
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

  /**
   * The container's own stdout/stderr -- what `docker logs <ref>` shows.
   * Nothing else this panel collects can see this: it is Docker's log
   * driver output, not a file on disk, so a support bundle built purely
   * from filesystem scans (this panel's own logs, the game server's own
   * log files) never contains it, even when it is the one line that
   * explains a production report (an early-startup crash from the
   * container's entrypoint script, a JVM that never got far enough to
   * write its own log file, etc.).
   *
   * Same fail-closed contract as runManagedAction()/inspectManagedContainer()
   * above: only ever returns data for a container this panel is allowed to
   * manage (zomboid-panel.managed=true), returns null on any failure
   * (Docker control off, socket unavailable, invalid ref, container not
   * managed, request error/timeout) rather than throwing -- callers should
   * treat null as "could not fetch", not as "empty log".
   */
  async getContainerLogs(containerId, { tail = DEFAULT_LOG_TAIL_LINES } = {}) {
    if (!this.available) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerId)) return null;
    const tailCount = Number.isInteger(tail) && tail > 0 ? tail : DEFAULT_LOG_TAIL_LINES;
    try {
      const container = await this.inspectManagedContainer(containerId);
      if (!container) return null;
      const raw = await this._requestBuffer(
        "GET",
        `/containers/${encodeURIComponent(containerId)}/logs?stdout=true&stderr=true&timestamps=true&tail=${tailCount}`,
      );
      return container.Config?.Tty === true ? raw.toString("utf-8") : demuxDockerLogStream(raw);
    } catch (error) {
      log.debug(`Docker logs fetch failed for ${containerId}: ${error.message}`);
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

  // Same shape as _requestJson but for a raw (non-JSON) body -- the logs
  // endpoint's response is either plain text (TTY container) or Docker's
  // multiplexed stdout/stderr frame format (see demuxDockerLogStream above),
  // neither of which is JSON. Enforces MAX_LOG_RESPONSE_BYTES itself, on top
  // of the caller's `tail=` line cap, since `tail=` bounds line count, not
  // byte count.
  _requestBuffer(method, requestPath, timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_LOG_RESPONSE_BYTES) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = http.request(
        { socketPath: this.socketPath, method, path: requestPath, timeout: timeoutMs },
        (response) => {
          if (response.statusCode >= 400) {
            response.resume();
            settled = true;
            reject(new Error(`Docker API returned ${response.statusCode}`));
            return;
          }
          const chunks = [];
          let total = 0;
          response.on("data", (chunk) => {
            if (settled) return;
            total += chunk.length;
            if (total > maxBytes) {
              settled = true;
              request.destroy();
              reject(new Error(`Docker API response exceeded ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks));
          });
        },
      );
      request.on("timeout", () => {
        if (settled) return;
        settled = true;
        // reject() directly rather than relying on the 'error' event
        // destroy(err) triggers -- that event fires asynchronously, by
        // which point `settled` is already true, so the error handler's
        // own guard below silently swallowed it and this promise never
        // settled at all. destroy() is still called, only for socket
        // cleanup now, not as the rejection path.
        const timeoutError = new Error("Docker API timed out");
        request.destroy(timeoutError);
        reject(timeoutError);
      });
      request.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
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
