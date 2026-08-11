/**
 * Routes server lifecycle actions to Docker when the target server is mapped
 * to a managed container.
 *
 * Why this exists: RCON `quit` and `serverManager.stopServer()` both act on the
 * *process*. Inside a container that process is PID 1, so killing it exits the
 * container — and a `restart: always` / `unless-stopped` policy immediately
 * brings the world back up. From the operator's seat the Stop button looks
 * broken. `docker stop` is a *manual* stop, which Docker exempts from restart
 * policies, so it is the only shutdown that actually sticks.
 *
 * Every caller keeps its own RCON save + guards; this module only decides who
 * owns the lifecycle action and performs the Docker half.
 */
import { getActiveServer, getServer } from "../database/init.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ManagedContainer");

// Wired once from index.js. Routes may still pass an explicit client.
let sharedDockerClient = null;

export function setDockerClient(client) {
  sharedDockerClient = client || null;
}

export function getDockerClient() {
  return sharedDockerClient;
}

/**
 * @returns {Promise<{handled: boolean, ref?: string, container?: object|null,
 *   running?: boolean, error?: string}>}
 *   `handled: false` means no managed container owns this server — the caller
 *   must fall back to its existing RCON/process path.
 */
export async function resolveManagedContainer({
  serverId = null,
  dockerClient = sharedDockerClient,
} = {}) {
  if (!dockerClient?.enabled || !dockerClient.available) return { handled: false };

  let server = null;
  try {
    server = serverId == null ? await getActiveServer() : await getServer(serverId);
  } catch (error) {
    log.debug(`Could not resolve the server profile: ${error.message}`);
    return { handled: false };
  }

  const ref = server?.dockerContainerName || server?.dockerContainerId || null;
  if (!ref) return { handled: false };

  const container = await dockerClient.inspectManagedContainer(ref);
  if (!container) {
    // Fail closed. Falling back to RCON here would kill the game process and
    // let the container's restart policy bring it straight back up — the exact
    // failure this module exists to prevent.
    return {
      handled: true,
      ref,
      container: null,
      error:
        `Container "${ref}" is mapped to this server but the panel cannot manage it. ` +
        `Check that it exists and carries the label zomboid-panel.managed=true.`,
    };
  }

  return {
    handled: true,
    ref,
    container,
    running: container.State?.Running === true,
  };
}

/**
 * @param {"start"|"stop"|"restart"} action
 * @returns {Promise<{handled: boolean, success?: boolean, message?: string, error?: string}>}
 */
export async function runManagedLifecycle(
  action,
  { serverId = null, dockerClient = sharedDockerClient } = {},
) {
  const resolved = await resolveManagedContainer({ serverId, dockerClient });
  if (!resolved.handled) return { handled: false };
  if (resolved.error) return { handled: true, success: false, error: resolved.error };

  if (action === "stop" && !resolved.running) {
    return { handled: true, success: true, message: "Container is already stopped" };
  }
  if (action === "start" && resolved.running) {
    return { handled: true, success: true, message: "Container is already running" };
  }

  const result = await dockerClient.runManagedAction(resolved.ref, action);
  log.info(
    `Managed container ${resolved.ref}: ${action} -> ${result?.success ? "ok" : result?.error || "failed"}`,
  );
  return { handled: true, ...result };
}
