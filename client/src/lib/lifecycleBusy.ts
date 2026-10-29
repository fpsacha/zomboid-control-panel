import i18n from '@/i18n'
import { ApiError, type LifecycleHolder, type LifecycleState } from './api'

// Why a Start/Stop/Restart (or switching the active server) is unavailable
// right now, worded for the operator, instead of letting the click run into
// the server's SERVER_LIFECYCLE_IN_PROGRESS 409. Mirrors the server's rules:
// lifecycleCoordinator.js's blockerFor() (the panel-wide lock refuses every
// server; a server waiting for its RCON after a start refuses only itself,
// and the operations that touch every server) and server.js's
// acquireLockForStop() (Stop and Force stop cancel a restart of the same
// server instead of being refused by it).

export type LifecycleAction = 'start' | 'stop' | 'forceStop' | 'restart' | 'switch'

// The server's operation names, grouped into what the operator recognises.
const OPERATION_LABELS: Array<[RegExp, string]> = [
  [/^(discord-)?start$/, 'start'],
  [/^(discord-)?stop$/, 'stop'],
  [/^force-stop$/, 'forceStop'],
  [/^(discord-)?restart$/, 'restart'],
  [/^(automatic|auto)-update$/, 'update'],
  [/^(backup-)?restore$/, 'restore'],
  [/^wipe$/, 'wipe'],
  [/^delete-(chunks|region|files)$/, 'delete'],
  [/^template-apply$/, 'template'],
  [/^server-profile-change$/, 'profile'],
  [/^startup-auto-start$/, 'autoStart'],
  [/^bridge-delivery-switch$/, 'bridge'],
  [/^docker-/, 'docker'],
]

function operationLabel(operation: string): string {
  const key = OPERATION_LABELS.find(([pattern]) => pattern.test(operation))?.[1] ?? 'other'
  return i18n.t(`lifecycleBusy.operations.${key}`, { ns: 'shell' })
}

export function describeLifecycleHolder(holder: LifecycleHolder): string {
  if (holder.phase === 'waiting-for-rcon' && holder.serverName) {
    return i18n.t('lifecycleBusy.waitingForRcon', { ns: 'shell', server: holder.serverName })
  }
  const operation = operationLabel(holder.operation)
  return holder.serverName
    ? i18n.t('lifecycleBusy.withServer', { ns: 'shell', operation, server: holder.serverName })
    : i18n.t('lifecycleBusy.noServer', { ns: 'shell', operation })
}

// What refuses `action` on `serverId` right now, or null.
export function lifecycleBlocker(
  state: LifecycleState | null | undefined,
  serverId: string | number | null | undefined,
  action: LifecycleAction,
): LifecycleHolder | null {
  if (!state) return null
  // Switching the active server waits for every server, as the server's
  // activate route does (panelWide).
  const id = action === 'switch' || serverId === null || serverId === undefined ? '' : String(serverId)
  // An older panel (or a reply without the list) sends no `servers`.
  const servers = Array.isArray(state.servers) ? state.servers : []
  const holder =
    state.lock ??
    (id ? servers.find((hold) => hold.serverId === id) : servers[0]) ??
    // Restarts run one at a time (the scheduler's restartInProgress): one
    // still waiting for its server's RCON refuses a restart of any other.
    (action === 'restart' ? servers.find((hold) => hold.operation === 'restart') : undefined) ??
    null
  if (!holder) return null
  const stopping = action === 'stop' || action === 'forceStop'
  if (stopping && holder.operation === 'restart' && (!holder.serverId || !id || holder.serverId === id)) {
    return null
  }
  return holder
}

export function lifecycleBusyReason(
  state: LifecycleState | null | undefined,
  serverId: string | number | null | undefined,
  action: LifecycleAction,
): string | null {
  const holder = lifecycleBlocker(state, serverId, action)
  return holder ? describeLifecycleHolder(holder) : null
}

// The reason behind a SERVER_LIFECYCLE_IN_PROGRESS refusal (a click that
// raced the lock state), or null for any other error.
export function lifecycleBusyFromError(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'SERVER_LIFECYCLE_IN_PROGRESS') return null
  const holder = (error.data as { holder?: LifecycleHolder | null } | undefined)?.holder
  return holder ? describeLifecycleHolder(holder) : error.message || null
}
