export type ServerProvider = 'native' | 'docker-local' | 'remote-sftp'

/**
 * Mirrors server/utils/serverStatusModel.js's resolveProvider so client code
 * can tell -- even before a composed-status fetch has resolved -- whether a
 * local process scan (status.running) is actually a trustworthy signal for
 * this server. `isRemote` alone isn't enough: it's false for BOTH native
 * and docker-managed servers, and only a native server runs as a process
 * this host's own scan can ever see. A docker-managed server's process runs
 * in a *different* container, so isRemote === false does not mean "the
 * scan can see it" -- treating it as if it did is exactly how GH#114
 * happened (a Docker container correctly shown running by the Docker panel
 * still read "down" on the same page, because the badge trusted the scan
 * for every non-remote server).
 */
export function resolveClientProvider(
  server: { isRemote?: boolean; dockerContainerName?: string | null } | null | undefined,
): ServerProvider | null {
  if (!server) return null
  if (server.isRemote) return 'remote-sftp'
  if (server.dockerContainerName) return 'docker-local'
  return 'native'
}

export interface ComposedStatusSignals {
  host: { status: string }
  server: { status: string }
  bridge: { status: string }
}

export interface DashboardStatusInput {
  hasServer: boolean
  // Accepts a plain string (not just ServerProvider) because Dashboard.tsx
  // prefers composedStatus's OWN `provider` field (server-authoritative,
  // typed as a plain string on ComposedServerStatus in lib/api.ts) over the
  // client-side resolveClientProvider() guess whenever it's available.
  provider: string | null
  status: { running?: boolean; rcon?: { connected?: boolean } } | null | undefined
  composedStatus: ComposedStatusSignals | null | undefined
}

export interface DashboardStatusOutput {
  hostRunning: boolean
  rconConnected: boolean
  bridgeActive: boolean
  hostUnknown: boolean
  online: boolean
}

/**
 * Composes Dashboard.tsx's host/RCON/bridge signals into the two booleans
 * its controls actually gate on: `hostRunning` (the narrower "is the OS
 * process/container itself visible" signal -- correct for things that
 * specifically need the process, like the Connect-RCON retry action) and
 * `online` (the broader "is there ANY evidence this server is up" signal --
 * correct for Start-vs-Stop branch selection and for whether Stop/Force
 * Stop/Restart should be clickable at all).
 *
 * LIVE BUG THIS FIXES (2026-08-29, Discord report, Linux/native provider):
 * Stop/Force Stop/Restart were all stuck disabled while RCON was genuinely
 * connected. Root cause traced to server/services/serverManager.js:1661 --
 * getServerStatus() (the plain, legacy `/status` endpoint `status` here
 * comes from) and the composed-status route both derive `running` from the
 * exact SAME getServerProcessDetails() scan, so a Linux-side scan that can't
 * see the process makes `status.running` a definite boolean `false`, not
 * `null`/`undefined`. `online`'s PREVIOUS formula re-applied
 * `localProcessStatus ??` at its own outer level even though hostRunning
 * (one of the three OR'd terms one level in) already carries that same
 * preference for the host-only portion -- and `false ?? X` evaluates to
 * `false` in JS, never falling through to `X`. That silently defeated the
 * entire RCON/bridge fallback for any native-provider server whose plain
 * scan had ever returned a definite `false`, which is nearly always once it
 * responds at all. Fixed by only falling back to `localProcessStatus` when
 * composedStatus itself is unavailable -- when it IS available, `online` is
 * the genuine `hostRunning || rconConnected || bridgeActive` OR, matching
 * server/utils/serverStatusModel.js's own "any independent live signal
 * counts" philosophy on the server side (see performRestart()'s explicit
 * RCON fallback and stopServer()'s scanFailed pattern-kill fallback, both of
 * which already treat a connected RCON as sufficient evidence server-side --
 * this brought the client's OWN combined signal into line with what the
 * server already tolerates).
 */
export function deriveDashboardStatus({
  hasServer,
  provider,
  status,
  composedStatus,
}: DashboardStatusInput): DashboardStatusOutput {
  const localProcessStatus =
    provider === 'native' && typeof status?.running === 'boolean' ? status.running : null
  const hostRunning =
    hasServer &&
    (localProcessStatus ?? (composedStatus ? composedStatus.host.status === 'running' : !!status?.running))
  const rconConnected = composedStatus
    ? composedStatus.server.status === 'connected'
    : Boolean(status?.rcon?.connected)
  const bridgeActive = composedStatus?.bridge.status === 'active'
  const hostUnknown = composedStatus ? ['unknown', 'not-applicable'].includes(composedStatus.host.status) : false
  const online =
    hasServer &&
    (composedStatus
      ? hostRunning || rconConnected || bridgeActive
      : (localProcessStatus ?? !!status?.running))
  return { hostRunning, rconConnected, bridgeActive, hostUnknown, online }
}

/**
 * Provider-aware "is the active server running" lookup, for a caller that
 * needs a hard true/false/unknown answer (a save-guard), not just a display
 * verdict. Shares the same 3-signal composed-status interpretation Layout.tsx
 * and Dashboard.tsx use (host running / RCON connected / bridge active), but
 * returns boolean | null instead of a 4-state display string, and takes its
 * fetchers as parameters so it's testable without a real network or a
 * component render -- same shape as waitForServerState below.
 *
 * FAIL CLOSED, deliberately: null means "could not determine," and every
 * caller of this function must treat null the same as true (assume it might
 * be running), never the same as false. This function only returns false
 * when a signal source POSITIVELY reports stopped -- never on a fetch
 * failure, an indeterminate composed host signal, or no active server at
 * all. A guard whose safe path is reachable only by an exception isn't a
 * guard: the common failure mode here is the lookup SUCCEEDING with a
 * confidently wrong answer (a docker container's process invisible to a
 * local scan), not throwing.
 */
export async function resolveServerRunning(
  server: { isRemote?: boolean; dockerContainerName?: string | null } | null | undefined,
  fetchNativeStatus: () => Promise<{ running?: boolean }>,
  fetchComposedStatus: () => Promise<ComposedStatusSignals>,
): Promise<boolean | null> {
  const provider = resolveClientProvider(server)
  if (provider == null) return null
  if (provider === 'native') {
    try {
      const status = await fetchNativeStatus()
      return Boolean(status.running)
    } catch {
      return null
    }
  }
  try {
    const composed = await fetchComposedStatus()
    const hostRunning = composed.host.status === 'running'
    const rconConnected = composed.server.status === 'connected'
    const bridgeActive = composed.bridge.status === 'active'
    const hostUnknown = ['unknown', 'not-applicable'].includes(composed.host.status)
    if (hostRunning || rconConnected || bridgeActive) return true
    return hostUnknown ? null : false
  } catch {
    return null
  }
}

export interface ServerStatusEntry {
  id: string | number
  running: boolean
  pid: string | null
}

export interface ServerStatusResponse {
  servers: ServerStatusEntry[]
}

export async function waitForServerState(
  fetchStatus: () => Promise<ServerStatusResponse>,
  serverId: string | number,
  expectedRunning: boolean,
  onStatus?: (status: ServerStatusEntry) => void,
  { timeoutMs = 30000, pollMs = 1000 }: { timeoutMs?: number; pollMs?: number } = {},
) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const data = await fetchStatus()
      const serverStatus = data.servers?.find((entry) => String(entry.id) === String(serverId))
      if (serverStatus) {
        onStatus?.(serverStatus)
        if (serverStatus.running === expectedRunning) return true
      }
    } catch {
      // A short process transition can briefly interrupt the status endpoint.
    }

    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
  }
}
