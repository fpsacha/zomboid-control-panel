import { useState, useEffect, useContext, useRef, useCallback, useMemo } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import {
  Server,
  Plus,
  Trash2,
  Edit2,
  Check,
  Power,
  MoreVertical,
  Loader2,
  FolderOpen,
  Download,
  Search,
  AlertCircle,
  CheckCircle,
  CheckCircle2,
  RefreshCw,
  ShieldCheck,
  Info,
  Globe,
  Monitor,
  Wifi,
  HardDrive,
  Database,
  ArrowRight,
  GitBranch,
  Cpu,
  Network,
  Play,
  Square,
  Container,
  RotateCw,
  Link,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { reportClientError, reportClientWarning } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { resolveRegisteredTranslation } from '@/lib/paramTranslation'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { serversApi, serversDetectApi, dockerApi, DockerContainerStats, DockerContainerSummary, ServerInstance, configApi, serverApi, updateApi, UpdateStatus, DiscoveredMount, MountDiscoveryCandidate, ComposedServerStatus } from '@/lib/api'
import { resolveClientProvider, resolveServerCardRunning, waitForServerState } from '@/lib/serverStatus'
import { getInstallProgressMessage } from '@/lib/installProgressMessage'
import { ServerStatusBadge } from '@/components/ServerStatusBadge'
import { SocketContext } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useAuth } from '@/contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { PasswordInput } from '@/components/PasswordInput'
import { NumberInput } from '@/components/NumberInput'
import { RconTestConnection } from '@/components/RconTestConnection'
import { MountDiscoveryBanner, InaccessibleMountBanner } from '@/components/MountDiscoveryBanner'
import { DiscoverySetup } from '@/components/DiscoverySetup'
import { DisabledReason } from '@/components/DisabledReason'
import { HelpTip } from '@/components/HelpTip'
import { platformTranslationKey, useRuntimeInfo } from '@/hooks/useRuntimeInfo'

interface DetectedServerConfig {
  dataPath: string
  serverConfigPath: string
  dockerContainerName: string
  serverName: string
  iniFile: string
  rconPort: number
  serverPort: number
  publicName: string
  hasRcon: boolean
  matchedBatFile?: string | null
  matchedInstallPath?: string | null
}

interface CustomBatFile {
  path: string
  folder: string
  fileName: string
  serverName: string
}

interface AutoScanResult {
  scanPath: string
  installPaths: string[]
  dataPaths: string[]
  customBatFiles: CustomBatFile[]
  detectedConfigs: DetectedServerConfig[]
}

interface DetectedServer {
  serverName: string
  iniFile: string
  rconPort: number
  serverPort: number
  publicName: string
  hasRcon: boolean
}

interface DetectResult {
  valid: boolean
  dataPath: string
  serverConfigPath: string
  installPath: string
  validInstallPath: boolean
  hasNoSteam: boolean
  detectedServers: DetectedServer[]
}

interface NewServerForm {
  name: string
  serverName: string
  installPath: string
  zomboidDataPath: string
  serverConfigPath: string
  dockerContainerName: string
  rconHost: string
  rconPort: number
  rconPassword: string
  serverPort: number
  minMemory: number
  maxMemory: number
  useNoSteam: boolean
  useDebug: boolean
  isRemote: boolean
}

const defaultNewServer: NewServerForm = {
  name: '',
  serverName: 'servertest',
  installPath: '',
  zomboidDataPath: '',
  serverConfigPath: '',
  dockerContainerName: '',
  rconHost: '127.0.0.1',
  rconPort: 27015,
  rconPassword: '',
  serverPort: 16261,
  minMemory: 2,
  maxMemory: 4,
  useNoSteam: false,
  useDebug: false,
  isRemote: false
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

// Mirrors the server's own range check (server/routes/servers.js POST /,
// "Invalid RCON port" / "Invalid server port") so the client can reject
// out-of-range ports before a round trip instead of after one.
// docker-unraid-add-server-experience (2026-09-09): new copy ships via this
// fallback rather than new locale JSON keys -- same call as the sandbox
// range-override toggle and MountDiscoveryBanner's new copy, for the same
// reason (a key registered in NO locale always resolves to English for
// everyone via this fallback, so localeParity.test.ts's 9-locale key-SET
// parity has nothing to be out of parity about).
function serversFallback(key: string, fallback: string): string {
  return resolveRegisteredTranslation('servers', key, undefined) ?? fallback
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export function isValidGamePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65534
}

// Client-side mirror of server/services/serverManager.js's resolveLaunchMode()
// -- a serverPath/installPath ending in .bat/.sh/.exe is CUSTOM LAUNCHER mode
// (operator ruling 2026-08-27, card
// custom-launcher-as-a-real-supported-mode-not-an-accident): the operator's
// own script, real and supported. Display-only, matching the server's own
// authoritative check (serverManager.js) rather than gating anything here --
// used to decide when to show the "the panel will not manage this script"
// notice, and by getInstallFolder() below (which used to duplicate this
// same regex inline).
export function isCustomLauncherPath(installPath: string | null | undefined): boolean {
  return !!installPath && /\.(bat|sh|exe)$/i.test(installPath)
}

// Client-side mirror of server.js's /delete-files nested-path check (via
// confineToRoots) -- informational only, so the delete dialog can warn
// BEFORE the request round-trips instead of the operator only finding out
// from a refusal after clicking. The server re-checks authoritatively on
// every call; this can't be trusted as the actual safety boundary on its
// own (no attempt at symlink resolution, case-folding is a Windows-only
// approximation of what the OS actually does).
export function isZomboidDataNestedInInstall(
  zomboidDataPath: string | null | undefined,
  installPath: string | null | undefined,
): boolean {
  if (!zomboidDataPath || !installPath) return false
  const normalize = (p: string) => p.replace(/[/\\]+$/, '').toLowerCase()
  const data = normalize(zomboidDataPath)
  const install = normalize(installPath)
  return data === install || data.startsWith(`${install}/`) || data.startsWith(`${install}\\`)
}

// Host status for a non-active docker-mapped server's card, from the
// already-fetched managed-container list -- never from the local process
// scan (serverStatuses), which can't see a process in a DIFFERENT container
// (GH#114). Mirrors server/utils/serverStatusModel.js's buildHostSignal
// fail-closed pattern: no container found, or Docker control itself
// unavailable, degrades to 'unknown', never a confident 'stopped'.
export function resolveDockerCardHostStatus(
  dockerAvailable: boolean,
  container: { state: string } | undefined,
): 'running' | 'stopped' | 'unknown' {
  if (!dockerAvailable || !container) return 'unknown'
  return container.state === 'running' ? 'running' : 'stopped'
}

// unknown-window-instances-outside-the-bridge, 2026-09-10: whether the
// Start/Stop controls for a docker-mapped server's card render AT ALL.
// Deliberately does NOT take dockerAvailable, unlike its neighbour above --
// fetchDockerState's periodic poll leaves dockerContainers stale-but-intact
// on a transient fetch failure while flipping dockerAvailable to false (a
// GENUINELY confirmed "Docker unavailable" response clears both together,
// see fetchDockerState's success branch, so this stays safe there too).
// Gating visibility on dockerAvailable as well used to hide these actions
// for as long as the next poll took, on nothing more than one dropped
// request -- for a container the panel still has recent, likely-accurate
// evidence is running. The asymmetry that justifies this: hiding Stop
// during that window costs an operator control of a possibly-misbehaving
// container; showing it during that window costs, at worst, a click that
// fails cleanly with a toast and immediately re-fetches (handleDockerAction).
// Not comparable -- resolveDockerCardHostStatus above still independently
// renders 'unknown' rather than a confident state during the same window,
// so the label stays honest either way.
export function shouldShowDockerCardActions<T>(
  container: T | null | undefined,
): container is T {
  return container != null
}

export default function Servers() {
  const { t, i18n } = useTranslation('servers')
  const runtimeInfo = useRuntimeInfo()
  const confirm = useConfirm()
  const { can } = useAuth()
  // bug-hunt-2026-08-27 (Tier 3 gating sweep): six distinct capabilities
  // gate this one page's privileged actions -- see the mapping sent to god
  // (dwight-tier3-table) for the full route-by-route trace. Open/true when
  // capabilities are unknown/null, same convention as every other capability
  // check in the app.
  const canDockerManage = can('docker.manage')
  const canServersManage = can('servers.manage')
  const canServerControl = can('server.control')
  const canServerWipe = can('server.wipe')
  const canServerInstall = can('server.install')
  const canServersDiscover = can('servers.discover')
  // Inline Start/Stop fires activate (servers.manage) THEN start/stop
  // (server.control) in sequence -- a role holding only one gets a PARTIAL
  // execution today (activate succeeds and the server record changes state,
  // then start/stop 403s), not a clean refusal. Gate on both present.
  const canInlineStartStop = canServersManage && canServerControl
  // null = we don't yet know (still loading, or the last fetch failed) --
  // distinct from [] (fetch succeeded and confirmed there really are zero
  // servers). See fetchServers() below: on failure `servers` is deliberately
  // left untouched rather than reset to [], so this stays accurate across
  // background refetches too, not just the first mount.
  const [servers, setServers] = useState<ServerInstance[] | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const serversConfirmedEmpty = servers !== null && servers.length === 0
  const [serverStatuses, setServerStatuses] = useState<Record<string, { running: boolean; pid: string | null; stateUnknown?: boolean }>>({})
  const [rconStatuses, setRconStatuses] = useState<Record<string, string>>({})
  const [dockerAvailable, setDockerAvailable] = useState(false)
  const [dockerContainers, setDockerContainers] = useState<DockerContainerSummary[]>([])
  const [dockerStats, setDockerStats] = useState<Record<string, DockerContainerStats>>({})
  const [dockerActionPending, setDockerActionPending] = useState<string | null>(null)
  // Full 3-signal status (host/RCON/bridge) for the active server only. Every
  // other card gets a host-only signal instead, sourced per provider: a
  // native server's card reads serverStatuses (the raw local process scan);
  // a docker-mapped server's card reads dockerContainers/dockerAvailable
  // (the managed-container list fetchDockerState() already fetches once for
  // every card on this page, not a per-card lookup) -- the scan can never
  // see a process in a DIFFERENT container, so it must never be the source
  // for those (GH#114). A remote-sftp card gets no host signal at all
  // (nothing here can verify it without SFTP access). There is no bridge
  // signal on any non-active card, docker or otherwise.
  const [activeStatus, setActiveStatus] = useState<ComposedServerStatus | null>(null)
  const [activeStatusServerId, setActiveStatusServerId] = useState<string | number | null>(null)
  const activeStatusRequestRef = useRef(0)
  const [loading, setLoading] = useState(true)
  const [managedLifecycleSupported, setManagedLifecycleSupported] = useState(false)
  const [editingServer, setEditingServer] = useState<ServerInstance | null>(null)
  // 2026-09-09 ruling (god), rule 3 ("guess, then let them change it"):
  // dockerContainerName used to be free-text only even though the real
  // container list is already loaded on this same page for the
  // container-management cards. null = no explicit user choice yet, so the
  // field auto-picks picker-vs-manual from whether the stored value matches
  // a known container; true/false once the user has explicitly clicked
  // "Type it in manually"/"Pick from detected containers instead", which
  // must WIN over that auto-detection -- otherwise switching back to the
  // picker to choose a NEW value immediately snaps back to manual, because
  // the OLD (still-unmatched) value hasn't changed yet. Reset to null
  // whenever the dialog (re)opens so a choice on one server doesn't leak
  // into the next server's edit dialog.
  const [dockerContainerManualOverride, setDockerContainerManualOverride] = useState<boolean | null>(null)
  useEffect(() => { setDockerContainerManualOverride(null) }, [editingServer?.id])
  const [savingEdit, setSavingEdit] = useState(false)
  const [lifecyclePending, setLifecyclePending] = useState(false)
  const [deleteServer, setDeleteServer] = useState<ServerInstance | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteProgress, setDeleteProgress] = useState(0)
  const deleteProgressRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Generation counter for the branch-fetch effect below -- steamcmdPath is a
  // live-typed text input, so a keystroke can re-fire the effect before the
  // previous fetchBranches() call resolves; without this, a slower response
  // from an earlier keystroke can land after a newer one and overwrite the
  // branch list / selected branch with stale data.
  const branchFetchIdRef = useRef(0)
  const [activating, setActivating] = useState<string | number | null>(null)

  // Add server dialog
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newServer, setNewServer] = useState<NewServerForm>(defaultNewServer)
  const [addingServer, setAddingServer] = useState(false)
  const [addMode, setAddMode] = useState<'local' | 'remote'>('local')

  // Two PZ servers on one host must not share a save folder, a server name or
  // a port. PZ binds serverPort and serverPort+1, so adjacent ports collide.
  const samePath = (a?: string | null, b?: string | null) =>
    !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

  const tandemConflicts = useMemo(() => {
    if (addMode !== 'local') return []
    const others = (servers || []).filter(s => !s.isRemote)
    if (others.length === 0) return []
    const found: Array<{ label: string; detail: string }> = []
    for (const other of others) {
      if (newServer.serverName && other.serverName === newServer.serverName) {
        found.push({ label: t('tandem.conflictConfigName'), detail: t('tandem.conflictConfigNameDetail', { name: other.name, serverName: other.serverName }) })
      }
      if (Math.abs(Number(other.serverPort) - Number(newServer.serverPort)) <= 1) {
        found.push({ label: t('tandem.conflictGamePort'), detail: t('tandem.conflictGamePortDetail', { name: other.name, port: other.serverPort, nextPort: Number(other.serverPort) + 1 }) })
      }
      if (Number(other.rconPort) === Number(newServer.rconPort)) {
        found.push({ label: t('tandem.conflictRconPort'), detail: t('tandem.conflictRconPortDetail', { name: other.name, port: other.rconPort }) })
      }
      if (samePath(other.zomboidDataPath, newServer.zomboidDataPath)) {
        found.push({ label: t('tandem.conflictSaveFolder'), detail: t('tandem.conflictSaveFolderDetail', { name: other.name }) })
      }
      if (samePath(other.installPath, newServer.installPath)) {
        found.push({ label: t('tandem.conflictInstallFolder'), detail: t('tandem.conflictInstallFolderDetail', { name: other.name }) })
      }
    }
    return found
  }, [addMode, servers, newServer.serverName, newServer.serverPort, newServer.rconPort, newServer.zomboidDataPath, newServer.installPath, t])

  // Same name+host+port collision handleSaveEdit already blocks Save on
  // (see its own comment for why -- bug-hunt-2026-08-31, f557c795) --
  // computed live here too so the two fields that actually collided keep a
  // persistent invalid marker after the save-time toast fades, instead of
  // only surfacing at the moment Save is clicked. Derived from current field
  // values every render, so it clears itself the instant either field no
  // longer collides -- no separate state to remember to reset.
  const editDuplicateRemoteConflict = useMemo(() => {
    if (!editingServer || !editingServer.isRemote) return false
    const normalizedName = (editingServer.name || '').trim().toLowerCase()
    const normalizedHost = (editingServer.rconHost || '').trim().toLowerCase()
    return (servers || []).some(s =>
      s.id !== editingServer.id &&
      s.isRemote &&
      (s.name || s.serverName || '').trim().toLowerCase() === normalizedName &&
      (s.rconHost || '').trim().toLowerCase() === normalizedHost &&
      s.rconPort === editingServer.rconPort
    )
  }, [editingServer, servers])

  // Detection state
  const [detecting, setDetecting] = useState(false)
  const [detectResult, setDetectResult] = useState<DetectResult | null>(null)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [selectedServerConfig, setSelectedServerConfig] = useState<string>('')
  // Set when the selected detected config has a password (hasRcon) that was
  // never sent to the browser -- POST /servers re-reads it server-side from
  // this exact reference instead. Cleared whenever the operator types their
  // own password, so a manual value always wins.
  const [importIniFrom, setImportIniFrom] = useState<{ dataPath: string; serverName: string } | null>(null)

  // Auto-scan state
  const [autoScanning, setAutoScanning] = useState(false)
  const [autoScanPath, setAutoScanPath] = useState('')
  const [autoScanResult, setAutoScanResult] = useState<AutoScanResult | null>(null)
  const [showAutoScan, setShowAutoScan] = useState(false)

  // Steam update/verify state
  const [steamOperation, setSteamOperation] = useState<{ server: ServerInstance; type: 'update' | 'verify'; branch: string } | null>(null)
  const [steamLogs, setSteamLogs] = useState<string[]>([])
  const [steamRunning, setSteamRunning] = useState(false)
  const [steamCompleted, setSteamCompleted] = useState<'success' | 'error' | null>(null)
  // bug-hunt-2026-09-06: steamRunning is only ever cleared by the
  // steam:complete socket event (or a launch-request-level catch) -- never
  // on success from the awaited serversApi.steamVerify/steamUpdate call,
  // which only confirms steamcmd was LAUNCHED, not that it finished. If
  // that event is dropped (the same "nobody's listening" shape as tonight's
  // server uploadStream crash, just silent instead of fatal here), this
  // dialog's own onOpenChange and Close button are BOTH disabled while
  // steamRunning -- there was no way to close it short of a page reload.
  // steamStalled is the escape hatch: true once STEAM_STALL_MS has passed
  // with no steam:log/steam:start activity, and re-enables closing the
  // dialog without fabricating a success/failure result.
  const [steamStalled, setSteamStalled] = useState(false)
  const steamLastActivityRef = useRef<number>(0)
  const [clearingInstall, setClearingInstall] = useState(false)
  const [confirmClearInstall, setConfirmClearInstall] = useState(false)
  const [steamcmdPath, setSteamcmdPath] = useState('')
  const [updateInfo, setUpdateInfo] = useState<UpdateStatus | null>(null)
  // 2026-09-08: does the game-update checker have ANY real answer on record?
  // Derived from getStatus()'s own updateAvailable field being non-null --
  // see api.ts's UpdateCheckerStatus comment for why that field, not
  // lastCheck, is the one that's success-only. Kept as its own state rather
  // than derived from updateInfo at render time so it can't accidentally
  // regress if updateInfo's own null-vs-populated rules ever change again.
  const [updateCheckEverSucceeded, setUpdateCheckEverSucceeded] = useState(false)
  const [updateCheckLastError, setUpdateCheckLastError] = useState<string | null>(null)
  const [gameVersion, setGameVersion] = useState<string | null>(null)
  const [availableBranches, setAvailableBranches] = useState<Array<{name: string, description: string, buildId?: string | null, timeUpdated?: string | null}>>([
    { name: 'public', description: t('branches.public') },
    { name: 'unstable', description: t('branches.unstable') }
  ])
  const [loadingBranches, setLoadingBranches] = useState(false)

  // Mount discovery — offers a one-click "connect this" profile when PZ
  // server files are found at a common bind-mount path and no profile
  // uses them yet. 2026-09-09: adopts Angela's real ranked `candidates`
  // field (fc74b688/c84f0f5c/99ed5c22, six-way `status` + a server-written
  // `reason` sentence per candidate) instead of the confirmedMounts/
  // partialMounts stand-in built before that contract existed -- one
  // vocabulary for one concept, per god's explicit instruction.
  const [discoveryCandidates, setDiscoveryCandidates] = useState<MountDiscoveryCandidate[]>([])
  const [scanningMounts, setScanningMounts] = useState(false)
  const [discoverySetupMount, setDiscoverySetupMount] = useState<DiscoveredMount | null>(null)
  const activeServerId = servers?.find((server) => server.isActive)?.id ?? null

  // Exclude a candidate that already matches a registered local server,
  // checking BOTH sides -- a Docker template can bind-mount the install and
  // data folders separately, so either one matching an existing profile
  // means this candidate is already connected, not still up for grabs.
  const unclaimedCandidates = discoveryCandidates.filter((candidate) => !(servers || []).some((server) =>
    !server.isRemote &&
    (samePath(server.installPath, candidate.installPath) || samePath(server.zomboidDataPath, candidate.dataPath)),
  ))
  // Angela's mechanical rule (2026-09-09 bar broadcast, rule 3): status
  // 'ready' is the only tier create-from-discovery can safely automate (it
  // needs a confirmed dataPath AND a server .ini to read RCON from).
  // 'install-only'/'data-only'/'empty' are real, useful signals -- "right
  // bind mount, contents not confirmed yet" (e.g. a freshly created Unraid
  // share nobody has started a server in) -- but hand off to the manual
  // form instead of guessing. 'not-mounted' and 'permission-denied' are
  // handled separately below: not-mounted is a checked-and-clear common
  // path, not a signal worth a banner; permission-denied gets its own
  // distinct treatment (no Add action makes sense there at all).
  const readyCandidates = unclaimedCandidates.filter((c) => c.status === 'ready')
  const reviewCandidates = unclaimedCandidates.filter((c) =>
    c.status === 'install-only' || c.status === 'data-only' || c.status === 'empty',
  )
  const inaccessibleCandidates = unclaimedCandidates.filter((c) => c.status === 'permission-denied')

  function candidateToDiscoveredMount(candidate: MountDiscoveryCandidate): DiscoveredMount {
    return {
      installPath: candidate.installPath || '',
      dataPath: candidate.dataPath,
      source: candidate.source,
      serverNames: candidate.serverNames,
      hasStartScript: candidate.hasStartScript,
      hasPanelBridge: candidate.hasPanelBridge,
    }
  }

  // A review-tier candidate can't go through create-from-discovery -- so
  // instead of guessing, hand what we DID find to the existing manual Add
  // Server form and let the user finish the one or two fields we couldn't
  // derive. Guess, then let them change it (rule 3), rather than an
  // all-or-nothing automation that only ever fires for the easy case.
  const handleReviewCandidateConnect = (candidate: MountDiscoveryCandidate) => {
    setAddMode('local')
    setNewServer((prev) => ({
      ...prev,
      installPath: candidate.installPath || prev.installPath,
      zomboidDataPath: candidate.dataPath || prev.zomboidDataPath,
      serverName: candidate.serverNames[0] || prev.serverName,
    }))
    setShowAddDialog(true)
  }

  const { toast } = useToast()
  const socket = useContext(SocketContext)
  const navigate = useNavigate()
  const currentActiveStatus = activeServerId !== null &&
    activeStatusServerId !== null &&
    String(activeServerId) === String(activeStatusServerId)
    ? activeStatus
    : null



  // Fetch servers
  //
  // 2026-09-08 (retry-stacking sweep): `manual` distinguishes a human
  // clicking the Retry button below from every other caller (the mount
  // effect, post-mutation refreshes, socket-triggered reloads) -- the
  // machine-initiated callers keep the default automatic retry (it's the
  // right tolerance for a transient blip nobody is watching), while a
  // manual retry passes {retries:0} because the human IS already the retry:
  // stacking a silent ~7s automatic one underneath their click just makes
  // the button look dead. Same shape as Dashboard.tsx's fetchStatus, which
  // solved this for its own polling by passing {retries:0} at the call site
  // rather than baking it into the shared function.
  const fetchServers = useCallback(async (opts?: { manual?: boolean }) => {
    setFetchError(null)
    try {
      const data = await serversApi.getAll(opts?.manual ? { retries: 0 } : undefined)
      setServers(data.servers || [])
      setManagedLifecycleSupported(data.lifecycleCapabilities?.supported === true)
    } catch (error) {
      reportClientError('Failed to fetch servers.', error)
      // Leave `servers` untouched -- a failed fetch must not read as "you
      // have no servers" (see the state's own comment above). The alert
      // below is the single, retry-able error affordance for this page's
      // load, same shape as Scheduler's fetchError.
      setFetchError(getUserErrorMessage(error, t('fetchError.fallback')))
    } finally {
      setLoading(false)
    }
  }, [t])

  // Per-server running status — scans host processes once and attributes
  // matches to each configured server's install path. Refreshes on a slow
  // 15s cadence (process detection is heavyweight) and on socket events.
  // Skipped while the tab is hidden so background tabs don't keep firing
  // a heavyweight host-process scan.
  const fetchServerStatuses = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    try {
      const data = await serversApi.getStatus({ retries: 0 })
      const next: Record<string, { running: boolean; pid: string | null; stateUnknown?: boolean }> = {}
      for (const s of data.servers || []) {
        next[String(s.id)] = { running: !!s.running, pid: s.pid, stateUnknown: s.stateUnknown === true }
      }
      setServerStatuses(next)
    } catch (error) {
      // Non-fatal: status is supplemental info, not the source of truth.
      reportClientWarning('Failed to fetch per-server status.', error)
    }
  }, [])

  const fetchRconStatuses = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    try {
      const data = await serversApi.getRconStatuses()
      setRconStatuses(Object.fromEntries((data.servers || []).map((server) => [String(server.id), server.status])))
    } catch (error) {
      reportClientWarning('Failed to fetch per-server RCON status.', error)
    }
  }, [])

  const fetchDockerState = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    try {
      const status = await dockerApi.getStatus()
      setDockerAvailable(status.enabled && status.available)
      setDockerContainers(status.containers || [])
      if (!status.enabled || !status.available) {
        setDockerStats({})
        return
      }
      const stats = await dockerApi.getStats()
      setDockerStats(stats.containers || {})
    } catch (error) {
      setDockerAvailable(false)
      reportClientWarning('Failed to fetch managed Docker state.', error)
    }
  }, [])

  const handleDockerAction = useCallback(async (
    container: DockerContainerSummary,
    action: 'start' | 'stop' | 'restart',
  ) => {
    if (!canDockerManage) return
    setDockerActionPending(`${action}-${container.id}`)
    try {
      const server = servers?.find((item) => item.dockerContainerName === container.name || item.dockerContainerName === container.id)
      if (!server) throw new Error('No server profile maps to this container')
      const result = await dockerApi.runAction(server.dockerContainerName || container.id, action, server.id)
      if (!result.success) throw new Error(result.error || `Failed to ${action} container`)
      const actionLabel = t(`toasts.dockerAction${action.charAt(0).toUpperCase()}${action.slice(1)}`)
      toast({ title: t('toasts.containerActionRequested', { action: actionLabel }), description: container.name, variant: 'success' as const })
      await fetchDockerState()
    } catch (error) {
      const actionLabel = t(`toasts.dockerAction${action.charAt(0).toUpperCase()}${action.slice(1)}`)
      toast({
        title: t('toasts.containerActionFailedTitle', { action: actionLabel }),
        description: getUserErrorMessage(error, t('toasts.containerActionFailedFallback')),
        variant: 'destructive',
      })
      // bug-hunt-2026-09-08 (start/stop reconcile audit): same reasoning as
      // Servers.tsx's inline start/stop catch blocks -- a client-side
      // error doesn't mean the container's real state matches what's still
      // on screen. Refetch immediately instead of leaving that gap open
      // for the existing 10s periodic poll to close later.
      void fetchDockerState()
    } finally {
      setDockerActionPending(null)
    }
  }, [fetchDockerState, servers, toast, t, canDockerManage])

  const handleConfigureRemoteBridge = useCallback(async (server: ServerInstance) => {
    if (!canServersManage) return
    try {
      if (!server.isActive) {
        await serversApi.activate(server.id)
        await fetchServers()
      }
      navigate('/settings?tab=bridge')
    } catch (error) {
      toast({
        title: t('toasts.couldNotSelectRemoteTitle'),
        description: getUserErrorMessage(error, t('toasts.serverActivationFailed')),
        variant: 'destructive',
      })
    }
  }, [fetchServers, navigate, toast, t, canServersManage])

  // Provider-aware host/RCON/bridge status for whichever server is active —
  // shown on its card via ServerStatusBadge instead of a single Running/
  // Stopped flag that hides RCON/bridge trouble behind a "running" container.
  const fetchActiveStatus = useCallback(async (serverId: string | number) => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const requestId = ++activeStatusRequestRef.current
    try {
      const nextStatus = await serversApi.getComposedStatus({ retries: 0 })
      if (requestId !== activeStatusRequestRef.current) return
      setActiveStatus(nextStatus)
      setActiveStatusServerId(serverId)
    } catch (error) {
      if (requestId !== activeStatusRequestRef.current) return
      setActiveStatus(null)
      setActiveStatusServerId(null)
      reportClientWarning('Failed to fetch active server status.', error)
    }
  }, [])

  // Load steamcmd path and servers on mount
  useEffect(() => {
    fetchServers()
    fetchServerStatuses()
    fetchRconStatuses()
    fetchDockerState()
    const statusInterval = setInterval(fetchServerStatuses, 15000)
    const rconStatusInterval = setInterval(fetchRconStatuses, 30000)
    const dockerInterval = setInterval(fetchDockerState, 10000)
    // Load steamcmd path from settings
    configApi.getAppSettings().then(data => {
      if (data.settings?.steamcmdPath) {
        setSteamcmdPath(data.settings.steamcmdPath)
      }
    }).catch(e => reportClientWarning('Failed to load settings.', e))
    // Load update status
    updateApi.getStatus().then(status => {
      // 2026-09-08 (widening the badge's third-state fix to a sibling
      // collapse): a REAL "checked, no update" result is just as much a
      // confirmed answer as a REAL "yes, update available" one -- both carry
      // the same installed/latest branch+build data the panel below renders.
      // Gating this on the inner updateAvailable boolean threw away that
      // data whenever the confirmed answer happened to be "no," so a clean,
      // successful mount-time check on an up-to-date server rendered
      // identically to "we have no idea" (no Branch & Build Info panel
      // either way). Store the object whenever one exists, regardless of
      // which way its own updateAvailable reads -- hasUpdate below already
      // reads that inner boolean correctly either way.
      if (status.updateAvailable) {
        setUpdateInfo(status.updateAvailable)
      }
      setUpdateCheckEverSucceeded(status.updateAvailable != null)
      setUpdateCheckLastError(status.lastError ?? null)
      if (status.gameVersion) {
        setGameVersion(status.gameVersion)
      }
    }).catch(e => reportClientWarning('Failed to load update status.', e))
    return () => {
      clearInterval(statusInterval)
      clearInterval(rconStatusInterval)
      clearInterval(dockerInterval)
    }
  }, [fetchServers, fetchServerStatuses, fetchRconStatuses, fetchDockerState])

  useEffect(() => {
    activeStatusRequestRef.current += 1
    setActiveStatus(null)
    setActiveStatusServerId(null)
    if (activeServerId === null) {
      return
    }
    void fetchActiveStatus(activeServerId)
    const interval = setInterval(() => void fetchActiveStatus(activeServerId), 10000)
    return () => {
      clearInterval(interval)
      activeStatusRequestRef.current += 1
    }
  }, [activeServerId, fetchActiveStatus])

  // Deliberately scoped to activeServerId, not broadened to every server row:
  // every server-side io.emit("server:status", ...) call site (routes/server.js,
  // index.js's checkServerStatusNow watchdog, scheduler.js's performRestart)
  // carries no server id in its payload and is driven off module-level
  // singleton state (lastKnownRunning/lastKnownPhase, rconService.serverStarting)
  // -- this backend tracks exactly one "the server" (the active one) at a
  // time, never several concurrently. There is no server id to route a push
  // to any other row with, so attributing it to activeServerId is the only
  // safe reading; writing it to every row would misattribute the active
  // server's transition onto unrelated, unmanaged configs.
  useEffect(() => {
    if (!socket || activeServerId === null) return

    const handleServerStatus = (data: { running?: boolean }) => {
      if (typeof data.running !== 'boolean') return
      setServerStatuses(prev => ({
        ...prev,
        [String(activeServerId)]: { running: data.running as boolean, pid: null },
      }))
      void fetchActiveStatus(activeServerId)
    }

    socket.on('server:status', handleServerStatus)
    return () => { socket.off('server:status', handleServerStatus) }
  }, [socket, activeServerId, fetchActiveStatus])

  // Silently probe for common bind-mount PZ installs — non-fatal since the
  // banner is a convenience, not a requirement.
  useEffect(() => {
    serversApi.discoverMounts()
      .then(data => setDiscoveryCandidates(data.candidates || []))
      .catch(e => reportClientWarning('Mount discovery failed.', e))
  }, [])

  const handleScanMounts = async () => {
    if (!canServersDiscover) return
    setScanningMounts(true)
    try {
      const data = await serversApi.discoverMounts()
      const candidates = data.candidates || []
      const readyCount = candidates.filter((c) => c.status === 'ready').length
      setDiscoveryCandidates(candidates)
      toast({
        title: readyCount
          ? t('toasts.serversFoundCount', { count: readyCount })
          : t('toasts.noServersFound'),
      })
    } catch (error) {
      toast({
        title: t('toasts.scanFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.mountDiscoveryFailed')),
        variant: 'destructive'
      })
    } finally {
      setScanningMounts(false)
    }
  }

  // Listen for update status changes (clears banner after successful update)
  useEffect(() => {
    if (!socket) return

    // Both events are only ever emitted from checkForUpdates()'s success
    // path (server/services/updateChecker.js) -- receiving either one here
    // is itself proof a check just succeeded, independent of whether THIS
    // particular result says an update is available. Store the payload
    // as-is rather than nulling it out on a false updateAvailable: a clean
    // "checked, no update" result is a real confirmed answer carrying the
    // same installed/latest branch+build data the Branch & Build Info panel
    // renders, not the absence of one -- same sibling collapse as the mount
    // fetch above, fixed the same way. hasUpdate's own read of
    // updateInfo?.updateAvailable is unaffected either way.
    const handleUpdateAvailable = (data: UpdateStatus) => {
      setUpdateInfo(data)
      setUpdateCheckEverSucceeded(true)
      setUpdateCheckLastError(null)
    }
    const handleUpdateCheck = (data: UpdateStatus) => {
      setUpdateInfo(data)
      setUpdateCheckEverSucceeded(true)
      setUpdateCheckLastError(null)
    }
    // ec0c8453 (server): the 5 failure returns in checkForUpdates() now emit
    // this live, on its own event name -- reusing the two above would have
    // made a live FAILURE set updateCheckEverSucceeded(true), the opposite
    // of what happened. Deliberately does NOT touch updateCheckEverSucceeded
    // here: a live failure after a prior success must keep showing the
    // stale-but-real result (880d14ff's succeeded-then-failed state), not
    // regress to the unknown badge. updateStatusUnknown's existing
    // derivation (server.isActive && !updateCheckEverSucceeded) already
    // covers both cases correctly once lastError alone is updated.
    const handleUpdateCheckFailed = (data: { lastError: string }) => {
      setUpdateCheckLastError(data.lastError)
    }

    socket.on('server:updateAvailable', handleUpdateAvailable)
    socket.on('server:updateCheck', handleUpdateCheck)
    socket.on('server:updateCheckFailed', handleUpdateCheckFailed)
    return () => {
      socket.off('server:updateAvailable', handleUpdateAvailable)
      socket.off('server:updateCheck', handleUpdateCheck)
      socket.off('server:updateCheckFailed', handleUpdateCheckFailed)
    }
  }, [socket])

  // Fetch available Steam branches when steam operation dialog opens
  useEffect(() => {
    if (!steamOperation) return

    const thisFetchId = ++branchFetchIdRef.current

    const fetchBranches = async () => {
      setLoadingBranches(true)
      try {
        const detection = await serverApi.detectSteamCmd()
        if (thisFetchId !== branchFetchIdRef.current) return
        const resolvedSteamcmdPath = detection.found && detection.path ? detection.path : steamcmdPath
        if (resolvedSteamcmdPath) {
          // Detection is asynchronous. Do not replace a path the operator
          // typed after the dialog opened but before detection completed.
          setSteamcmdPath((currentPath) => currentPath.trim() || resolvedSteamcmdPath)
        }
        const data = await serverApi.getBranches(resolvedSteamcmdPath)
        if (thisFetchId !== branchFetchIdRef.current) return
        if (data.branches && Array.isArray(data.branches)) {
          setAvailableBranches(() => {
            const fetched = data.branches as Array<{ name: string; description: string; buildId?: string | null }>
            // SteamCMD's anonymous branch listing usually only returns `public`.
            // Make sure the installed branch, the server's branch, and the currently
            // selected branch all remain pickable so we never silently drop the user's choice.
            const extras: typeof fetched = []
            const have = new Set(fetched.map(b => b.name))
            const normalize = (v: string | undefined | null) => (v || '').trim().toLowerCase()
            const candidates = [
              normalize(updateInfo?.installed?.branch),
              normalize(steamOperation?.server.branch),
              normalize(steamOperation?.branch),
            ].filter(Boolean) as string[]
            for (const name of candidates) {
              if (!have.has(name)) {
                const description = name === 'unstable'
                  ? t('branches.unstableDesc')
                  : name === 'iwbums'
                    ? t('branches.iwbumsDesc')
                    : t('branches.genericBetaDesc')
                extras.push({ name, description })
                have.add(name)
              }
            }
            return [...fetched, ...extras]
          })
          // Only reconcile the selected branch if it's truly unknown and not the
          // installed/server branch. Never override what the server is actually running.
          setSteamOperation((prev) => {
            if (!prev) return prev
            const names = new Set(data.branches.map((b: { name: string }) => b.name))
            const installed = (updateInfo?.installed?.branch || '').trim().toLowerCase()
            const serverBranch = (prev.server.branch || '').trim().toLowerCase()
            if (prev.branch === installed) return prev
            if (prev.branch === serverBranch) return prev
            if (names.has(prev.branch)) return prev
            const fallback = installed || serverBranch || (names.has('public') ? 'public' : data.branches[0]?.name)
            return fallback ? { ...prev, branch: fallback } : prev
          })
        }
      } catch (error) {
        reportClientError('Failed to fetch branches.', error)
        // Keep default branches on error
      } finally {
        if (thisFetchId === branchFetchIdRef.current) setLoadingBranches(false)
      }
    }

    fetchBranches()
  }, [steamOperation, steamcmdPath, updateInfo?.installed?.branch, t])

  // Listen for server changes
  useEffect(() => {
    if (!socket) return

    const handleActiveServerChanged = () => {
      activeStatusRequestRef.current += 1
      setActiveStatus(null)
      setActiveStatusServerId(null)
      fetchServers()
    }

    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, fetchServers])

  // Listen for Steam update/verify events
  useEffect(() => {
    if (!socket) return

    const handleSteamStart = (data: { type: string; message: string; progressCode?: string; params?: Record<string, string | number> }) => {
      steamLastActivityRef.current = Date.now()
      setSteamRunning(true)
      setSteamStalled(false)
      setSteamLogs([getInstallProgressMessage(data, data.message)])
    }

    const handleSteamLog = (data: { type: string; text: string; progressCode?: string; params?: Record<string, string | number> }) => {
      steamLastActivityRef.current = Date.now()
      setSteamStalled(false)
      setSteamLogs(prev => [...prev.slice(-200), getInstallProgressMessage(data, data.text)]) // Keep last 200 lines
    }

    const handleSteamComplete = (data: { success: boolean; message: string; progressCode?: string; params?: Record<string, string | number> }) => {
      const displayMessage = getInstallProgressMessage(data, data.message)
      setSteamRunning(false)
      setSteamStalled(false)
      setSteamCompleted(data.success ? 'success' : 'error')
      setSteamLogs(prev => [...prev, '', data.success ? '✓ ' + displayMessage : '✗ ' + displayMessage])
      toast({
        title: data.success ? t('toasts.success') : t('toasts.failed'),
        description: displayMessage,
        variant: data.success ? 'default' : 'destructive'
      })
    }

    socket.on('steam:start', handleSteamStart)
    socket.on('steam:log', handleSteamLog)
    socket.on('steam:complete', handleSteamComplete)

    return () => {
      socket.off('steam:start', handleSteamStart)
      socket.off('steam:log', handleSteamLog)
      socket.off('steam:complete', handleSteamComplete)
    }
  }, [socket, toast, t])

  // Watchdog for the steam:complete-never-arrives case above: if no
  // steam:start/steam:log activity has landed in STEAM_STALL_MS, treat the
  // dialog as stalled rather than trusting steamRunning to resolve on its
  // own. Doesn't fabricate a success/failure -- just restores the user's
  // ability to close the dialog and check actual server status another way.
  useEffect(() => {
    if (!steamRunning) return
    const STEAM_STALL_MS = 3 * 60 * 1000
    const interval = setInterval(() => {
      if (Date.now() - steamLastActivityRef.current >= STEAM_STALL_MS) {
        setSteamStalled(true)
      }
    }, 15000)
    return () => clearInterval(interval)
  }, [steamRunning])

  // Detect server settings from data path
  const handleDetectServer = async () => {
    if (!canServersDiscover) return
    if (!newServer.zomboidDataPath.trim()) {
      toast({ title: t('toasts.error'), description: t('toasts.enterDataPathFirst'), variant: 'destructive' })
      return
    }

    setDetecting(true)
    setDetectError(null)
    setDetectResult(null)
    setSelectedServerConfig('')
    setImportIniFrom(null)

    try {
      const data = await serversDetectApi.detect({
        dataPath: newServer.zomboidDataPath,
        installPath: newServer.installPath || undefined
      }) as unknown as DetectResult & { error?: string }

      if (!data || data.error) {
        setDetectError(data?.error || t('toasts.detectionFailed'))
        return
      }

      setDetectResult(data)

      // Auto-select first server if only one
      if (data.detectedServers.length === 1) {
        handleSelectServerConfig(data.detectedServers[0], data)
      } else if (data.detectedServers.length > 1) {
        toast({
          title: t('toasts.multipleServersFoundTitle'),
          description: t('toasts.multipleServersFoundDesc')
        })
      }

      // Update useNoSteam based on detection
      if (data.hasNoSteam) {
        setNewServer(prev => ({ ...prev, useNoSteam: true }))
      }

    } catch (error) {
      setDetectError(getUserErrorMessage(error, t('toasts.detectionFailed')))
    } finally {
      setDetecting(false)
    }
  }

  // Auto-scan a folder to find all PZ server paths
  const handleAutoScan = async () => {
    if (!canServersDiscover) return
    if (!autoScanPath.trim()) {
      toast({ title: t('toasts.error'), description: t('toasts.enterScanFolder'), variant: 'destructive' })
      return
    }

    setAutoScanning(true)
    setAutoScanResult(null)

    try {
      const data = await serversDetectApi.autoScan({ scanPath: autoScanPath, maxDepth: 4 }) as unknown as AutoScanResult & { error?: string }

      if (!data || data.error) {
        toast({ title: t('toasts.scanFailedTitle'), description: data.error || t('toasts.scanFailedUnknown'), variant: 'destructive' })
        return
      }

      setAutoScanResult(data)

      if (data.detectedConfigs.length === 0) {
        toast({
          title: t('toasts.noServersFound'),
          description: t('toasts.noServersFoundInFolder')
        })
      } else {
        toast({
          title: t('toasts.serversFoundTitle'),
          description: t('toasts.serversFoundDesc', { count: data.detectedConfigs.length })
        })
      }

    } catch (error) {
      toast({
        title: t('toasts.scanFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.autoScanFailed')),
        variant: 'destructive'
      })
    } finally {
      setAutoScanning(false)
    }
  }

  // Select a scanned server config and populate the form
  const handleSelectScannedConfig = (config: DetectedServerConfig, installPath?: string) => {
    // Use matched bat file if available, otherwise use provided installPath
    const effectiveInstallPath = config.matchedBatFile || installPath || ''

    setNewServer({
      ...defaultNewServer,
      name: config.publicName || config.serverName,
      serverName: config.serverName,
      zomboidDataPath: config.dataPath,
      installPath: effectiveInstallPath,
      rconPort: config.rconPort,
      serverPort: config.serverPort,
    })
    setSelectedServerConfig(config.serverName)
    setImportIniFrom(config.hasRcon ? { dataPath: config.dataPath, serverName: config.serverName } : null)
    setShowAutoScan(false)

    // Also set the detect result for consistency
    setDetectResult({
      valid: true,
      dataPath: config.dataPath,
      serverConfigPath: config.serverConfigPath,
      installPath: effectiveInstallPath,
      validInstallPath: !!effectiveInstallPath,
      hasNoSteam: false,
      detectedServers: [{
        serverName: config.serverName,
        iniFile: config.iniFile,
        rconPort: config.rconPort,
        serverPort: config.serverPort,
        publicName: config.publicName,
        hasRcon: config.hasRcon
      }]
    })

    if (!config.hasRcon) {
      toast({
        title: t('toasts.rconNotConfiguredTitle'),
        description: t('toasts.rconNotConfiguredDesc'),
        variant: 'destructive'
      })
    }
  }

  // Select a detected server config
  const handleSelectServerConfig = (config: DetectedServer, result?: DetectResult) => {
    const res = result || detectResult
    setSelectedServerConfig(config.serverName)
    setNewServer(prev => ({
      ...prev,
      name: config.publicName || config.serverName,
      serverName: config.serverName,
      zomboidDataPath: res?.dataPath || prev.zomboidDataPath,
      serverConfigPath: res?.serverConfigPath || prev.serverConfigPath,
      rconPort: config.rconPort,
      rconPassword: '',
      serverPort: config.serverPort
    }))
    setImportIniFrom(
      config.hasRcon && res?.dataPath
        ? { dataPath: res.dataPath, serverName: config.serverName }
        : null,
    )

    if (!config.hasRcon) {
      toast({
        title: t('toasts.rconNotConfiguredTitle'),
        description: t('toasts.rconNotConfiguredDesc'),
        variant: 'destructive'
      })
    }
  }

  const handleActivateServer = useCallback(async (server: ServerInstance) => {
    if (server.isActive) return
    if (!canServersManage) return

    setActivating(server.id)
    try {
      await serversApi.activate(server.id)
      toast({
        title: t('toasts.serverActivatedTitle'),
        description: t('toasts.serverActivatedDesc', { name: server.name })
      })
      fetchServers()
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.activateFailed')),
        variant: 'destructive'
      })
    } finally {
      setActivating(null)
    }
  }, [toast, fetchServers, t, canServersManage])

  // Inline Start/Stop on server cards. The Node side `serverApi.start/stop`
  // operate on the currently-active instance only, so for inactive servers
  // we activate first, wait for the switch to land, then issue start. This
  // mirrors what users would otherwise do manually from the dropdown.
  const [serverActionPending, setServerActionPending] = useState<string | null>(null)
  const waitForActionState = useCallback(async (serverId: string | number, expectedRunning: boolean) => {
    return waitForServerState(
      () => serversApi.getStatus({ retries: 0 }),
      serverId,
      expectedRunning,
      (serverStatus) => {
        setServerStatuses(prev => ({
          ...prev,
          // stateUnknown must survive this write -- dropping it here reset the
          // flag to falsy on every poll tick during an inline start/stop
          // action, so a mid-transition "the scan couldn't tell" response
          // still displayed as a confident running/stopped card the instant
          // it landed (2026-09-08 three-state audit).
          [String(serverStatus.id)]: {
            running: serverStatus.running,
            pid: serverStatus.pid,
            stateUnknown: serverStatus.stateUnknown === true,
          },
        }))
      },
    )
  }, [])

  const handleInlineStart = useCallback(async (server: ServerInstance) => {
    if (!canInlineStartStop) return
    setServerActionPending(`start-${server.id}`)
    try {
      if (!server.isActive) {
        await serversApi.activate(server.id)
      }
      // /server/start always responds non-2xx on failure, so
      // handleResponse() throws into the catch below -- this never sees
      // result.success === false.
      await serverApi.start()
      const confirmed = await waitForActionState(server.id, true)
      toast({
        title: confirmed ? t('toasts.serverStartedTitle') : t('toasts.serverStartRequestedTitle'),
        description: confirmed ? (server.name || server.serverName) : t('toasts.waitingForProcess'),
        variant: confirmed ? 'success' as const : 'default',
      })
      await Promise.allSettled([fetchServers(), fetchServerStatuses()])
    } catch (error) {
      toast({
        title: t('toasts.startFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.unknownError')),
        variant: 'destructive',
      })
      // bug-hunt-2026-09-08 (start/stop reconcile audit): a client-side
      // error here (network drop, a real 4xx/5xx) does NOT mean the
      // server's actual running state matches what's still on screen --
      // this is the same "operation may have succeeded despite a client-
      // observed failure" shape the timeout-class sweep found tonight.
      // Without this, the card shows stale state in the seconds right
      // after the click, which is exactly when an operator is watching
      // and most likely to click Start a second time against a server
      // whose real state neither side agrees on. The 15s periodic poll
      // would eventually correct it either way; this closes the gap
      // immediately instead of leaving the wrong state on screen at the
      // moment it does the most damage.
      void Promise.allSettled([fetchServers(), fetchServerStatuses()])
    } finally {
      setServerActionPending(null)
    }
  }, [toast, fetchServers, fetchServerStatuses, waitForActionState, t, canInlineStartStop])

  const handleInlineStop = useCallback(async (server: ServerInstance) => {
    if (!canInlineStartStop) return
    // Unlike the Dashboard's Stop button (which gates behind a confirm
    // dialog), this inline card button ran the stop immediately on click --
    // a single misclick disconnects everyone on the server with no chance
    // to back out. Reversible (start it again anytime), so this stays a
    // plain, non-destructive-styled confirm rather than full alarm styling.
    const ok = await confirm({
      title: t('card.stopConfirmTitle'),
      description: t('card.stopConfirmDescription'),
      confirmLabel: t('card.stop'),
      destructive: false,
    })
    if (!ok) return
    setServerActionPending(`stop-${server.id}`)
    try {
      if (!server.isActive) {
        await serversApi.activate(server.id)
      }
      // Same shape as handleInlineStart above: /server/stop's failures all
      // throw via handleResponse(), so this never sees
      // result.success === false.
      await serverApi.stop()
      const confirmed = await waitForActionState(server.id, false)
      toast({
        title: confirmed ? t('toasts.serverStoppedTitle') : t('toasts.serverStopRequestedTitle'),
        description: confirmed ? (server.name || server.serverName) : t('toasts.waitingForStop'),
        variant: confirmed ? 'success' as const : 'default',
      })
      await Promise.allSettled([fetchServers(), fetchServerStatuses()])
    } catch (error) {
      toast({
        title: t('toasts.stopFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.unknownError')),
        variant: 'destructive',
      })
      // bug-hunt-2026-09-08 (start/stop reconcile audit): same reasoning as
      // handleInlineStart's catch above -- refetch immediately rather than
      // leave stale (possibly wrong) state on screen right when the
      // operator is watching and most likely to click Stop again.
      void Promise.allSettled([fetchServers(), fetchServerStatuses()])
    } finally {
      setServerActionPending(null)
    }
  }, [toast, fetchServers, fetchServerStatuses, waitForActionState, t, confirm, canInlineStartStop])

  const handleDeleteServer = async () => {
    if (!deleteServer) return
    if (!canServersManage) return

    setDeleting(true)
    setDeleteProgress(0)

    // Animate progress: fast to ~70%, then slow crawl to ~90%
    let prog = 0
    deleteProgressRef.current = setInterval(() => {
      prog += prog < 70 ? 8 : 1
      if (prog > 92) prog = 92
      setDeleteProgress(prog)
    }, 200)

    // Whether the files were ACTUALLY deleted, not just requested -- a
    // refusal (wrong folder, or the new nested-data-path guard) or a
    // thrown network error both leave the files untouched even though the
    // panel record removal below still proceeds either way (existing
    // behavior, unchanged: the "removingFromPanelAnyway" copy already says
    // so explicitly for the thrown-error case). The final toast must not
    // claim files were deleted when they were not -- that was true even
    // before the nested-path guard existed, just less likely to fire.
    let filesActuallyDeleted = false

    try {
      // If deleteFiles is checked and server has an installPath, delete the files first.
      // The checkbox itself is gated on server.wipe (can't be checked without it) --
      // this canServerWipe re-check is defense-in-depth per Angela's Console.tsx
      // lesson (disabled control != gate), and skips the file-delete step rather
      // than aborting the whole action: panel-record-only deletion is a
      // legitimately lower bar than servers.manage already grants.
      if (deleteFiles && deleteServer.installPath && canServerWipe) {
        try {
          const result = await serversDetectApi.deleteFiles(deleteServer.installPath) as { error?: string }
          if (result?.error) {
            toast({
              title: t('toasts.fileDeletionFailedTitle'),
              description: result.error,
              variant: 'destructive'
            })
          } else {
            filesActuallyDeleted = true
          }
        } catch (e) {
          const msg = getUserErrorMessage(e, t('toasts.couldNotDeleteFiles'))
          toast({
            title: t('toasts.warningTitle'),
            description: t('toasts.removingFromPanelAnyway', { message: msg }),
            variant: 'destructive'
          })
        }
      }

      await serversApi.delete(deleteServer.id)

      // Complete the progress bar before closing
      if (deleteProgressRef.current) clearInterval(deleteProgressRef.current)
      setDeleteProgress(100)
      await new Promise(r => setTimeout(r, 350))

      toast({
        title: t('toasts.deletedTitle'),
        description: filesActuallyDeleted
          ? t('toasts.deletedWithFiles', { name: deleteServer.name })
          : t('toasts.deletedFromPanel', { name: deleteServer.name })
      })
      setDeleteServer(null)
      setDeleteFiles(false)
      fetchServers()
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.deleteServerFailed')),
        variant: 'destructive'
      })
    } finally {
      if (deleteProgressRef.current) clearInterval(deleteProgressRef.current)
      setDeleting(false)
      setDeleteProgress(0)
    }
  }

  const handleSaveEdit = async () => {
    if (!editingServer || savingEdit) return
    if (!canServersManage) return
    const storedLifecycleProvider =
      servers?.find((server) => server.id === editingServer.id)?.lifecycleProvider || 'direct'
    if ((editingServer.lifecycleProvider || 'direct') !== storedLifecycleProvider) {
      toast({
        title: t('toasts.warningTitle'),
        description: t('editDialog.lifecycleCompleteFirst'),
        variant: 'destructive',
      })
      return
    }

    // Validate port range
    if (!isValidPort(editingServer.rconPort)) {
      toast({ title: t('toasts.error'), description: t('toasts.rconPortRangeError'), variant: 'destructive' })
      return
    }
    if (!isValidGamePort(editingServer.serverPort)) {
      toast({ title: t('toasts.error'), description: t('toasts.gamePortRangeError'), variant: 'destructive' })
      return
    }
    if (!Number.isFinite(editingServer.minMemory) || !Number.isFinite(editingServer.maxMemory)) {
      toast({ title: t('toasts.error'), description: t('toasts.memoryRequiredError'), variant: 'destructive' })
      return
    }

    // The dialog already shows this as a red warning under the field (see
    // customStartCommandDisallowed below) but was never wired to block Save --
    // the server rejects the same characters at start time (validateStartCommand
    // in serverManager.js), so an unblocked save looked successful and only
    // failed later, on the next start attempt, with no link back to this dialog.
    if (editingServer.startCommand && /[&|;<>`${}()!\[\]]/.test(editingServer.startCommand)) {
      toast({ title: t('toasts.error'), description: t('editDialog.customStartCommandDisallowed'), variant: 'destructive' })
      return
    }

    // bug-hunt-2026-08-31: f557c795 added this same check to Add Remote
    // Server only. server/routes/servers.js has no uniqueness enforcement
    // of its own (confirmed by god -- grepped the whole file for
    // duplicate/already-exists/unique, only hits are a required-fields list
    // and rconFieldsChanged), so editing an existing remote server's
    // name/host/port to collide with another server reproduces the exact
    // same two-indistinguishable-cards outcome the Add-path fix exists to
    // prevent. Excludes the server being edited from its own comparison.
    // Shares editDuplicateRemoteConflict's own logic (defined above with the
    // other hooks) rather than re-deriving it here, so the persistent
    // field-level styling below can never drift from what actually blocks
    // Save.
    if (editDuplicateRemoteConflict) {
      toast({
        title: t('toasts.error'),
        description: t('toasts.duplicateRemoteServer', { name: (editingServer.name || '').trim() }),
        variant: 'destructive',
      })
      return
    }

    setSavingEdit(true)
    try {
      const result = await serversApi.update(editingServer.id, editingServer)
      const warnings = result.warnings?.filter(Boolean) ?? []
      toast({
        title: warnings.length > 0 ? t('toasts.warningTitle') : t('toasts.savedTitle'),
        description: warnings.length > 0
          ? `${t('toasts.savedDesc')}. ${warnings.join(' ')}`
          : t('toasts.savedDesc')
      })
      setEditingServer(null)
      fetchServers()
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.updateServerFailed')),
        variant: 'destructive'
      })
    } finally {
      setSavingEdit(false)
    }
  }

  const handleDownloadLifecycleTemplate = async (server: ServerInstance) => {
    const provider = server.lifecycleProvider || 'direct'
    if (provider === 'direct' || lifecyclePending) return
    setLifecyclePending(true)
    try {
      const template = await serversApi.getLifecycleTemplate(server.id, provider)
      const blob = new Blob([template.content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = template.filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      toast({
        title: t('editDialog.lifecycleTemplateReadyTitle'),
        description: t('editDialog.lifecycleTemplateReadyDesc', { path: template.installPath }),
      })
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('editDialog.lifecycleTemplateFailed')),
        variant: 'destructive',
      })
    } finally {
      setLifecyclePending(false)
    }
  }

  const handleActivateLifecycleProvider = async (server: ServerInstance) => {
    const provider = server.lifecycleProvider || 'direct'
    const stored = servers?.find((candidate) => candidate.id === server.id)
    const currentProvider = stored?.lifecycleProvider || 'direct'
    if (provider === currentProvider || lifecyclePending) return

    const accepted = await confirm({
      title: t('editDialog.lifecycleConfirmTitle'),
      description: t('editDialog.lifecycleConfirmDesc', {
        current: currentProvider,
        next: provider,
      }),
      confirmLabel: t('editDialog.lifecycleActivate'),
      destructive: false,
      variant: 'warning',
    })
    if (!accepted) return

    setLifecyclePending(true)
    try {
      const result = await serversApi.activateLifecycleProvider(server.id, provider)
      setEditingServer(result.server)
      await fetchServers()
      toast({
        title: t('editDialog.lifecycleActivatedTitle'),
        description: result.message,
      })
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('editDialog.lifecycleActivationFailed')),
        variant: 'destructive',
      })
    } finally {
      setLifecyclePending(false)
    }
  }

  // Start Steam update/verify operation
  const handleStartSteamOperation = async () => {
    if (!canServerInstall) return
    if (!steamOperation || !steamcmdPath.trim()) {
      toast({ title: t('toasts.error'), description: t('toasts.steamcmdPathRequired'), variant: 'destructive' })
      return
    }

    const installFolder = getInstallFolder(steamOperation.server.installPath)
    if (!installFolder) {
      toast({ title: t('toasts.error'), description: t('toasts.installPathNotConfigured'), variant: 'destructive' })
      return
    }

    // Save steamcmd path to settings for future use
    try {
      await configApi.updateAppSettings({ steamcmdPath })
    } catch (e) {
      // Non-critical, continue anyway
    }

    setSteamLogs([])
    setSteamRunning(true)
    setSteamStalled(false)
    steamLastActivityRef.current = Date.now()
    setSteamCompleted(null)

    try {
      if (steamOperation.type === 'verify') {
        await serversApi.steamVerify(steamcmdPath, installFolder, steamOperation.branch)
      } else {
        await serversApi.steamUpdate(steamcmdPath, installFolder, steamOperation.branch)
      }
    } catch (error) {
      setSteamRunning(false)
      setSteamStalled(false)
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.startOperationFailed')),
        variant: 'destructive'
      })
    }
  }

  // Wipe the install folder so a stuck/corrupted SteamCMD state (partial
  // download, mismatched appmanifest, "Missing configuration" etc.) can be
  // fixed by reinstalling from scratch, without needing shell access.
  // Reuses the same guarded /delete-files endpoint the "Remove Server ->
  // Delete Everything" flow uses (requires PZ marker files to be present,
  // refuses to delete folders it doesn't recognize as a PZ install).
  const handleClearInstallFolder = async () => {
    if (!canServerWipe) return
    if (!steamOperation) return
    const installFolder = getInstallFolder(steamOperation.server.installPath)
    if (!installFolder) {
      toast({ title: t('toasts.error'), description: t('toasts.installPathNotConfigured'), variant: 'destructive' })
      return
    }

    setClearingInstall(true)
    try {
      const result = await serversDetectApi.deleteFiles(installFolder) as { error?: string }
      if (result?.error) {
        toast({ title: t('toasts.couldNotClearFolderTitle'), description: result.error, variant: 'destructive' })
        return
      }
      setSteamLogs([])
      setSteamCompleted(null)
      toast({
        title: t('toasts.installFolderClearedTitle'),
        description: t('toasts.installFolderClearedDesc'),
      })
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.clearFolderFailed')),
        variant: 'destructive',
      })
    } finally {
      setClearingInstall(false)
      setConfirmClearInstall(false)
    }
  }

  // Open steam operation dialog
  const openSteamOperation = async (server: ServerInstance, type: 'update' | 'verify') => {
    // Prefer the branch that's actually installed on disk (from steamcmd appmanifest),
    // then fall back to the server's stored branch, then to Steam's default 'public'.
    // Steam's stable branch is named 'public'; map legacy 'stable' to it so it matches the fetched list.
    const normalize = (v: string | undefined | null) => (v || '').trim().toLowerCase()
    const installed = normalize(updateInfo?.installed?.branch)
    const stored = normalize(server.branch)
    const pick = installed || stored
    const initialBranch = !pick || pick === 'stable' ? 'public' : pick
    setSteamOperation({ server, type, branch: initialBranch })
    setSteamLogs([])
    setSteamRunning(false)
    setSteamStalled(false)
    setSteamCompleted(null)

    // Load steamcmd path from settings if not already set
    if (!steamcmdPath) {
      try {
        const data = await configApi.getAppSettings()
        if (data.settings?.steamcmdPath) {
          setSteamcmdPath(data.settings.steamcmdPath)
        }
      } catch (e) {
        // Ignore - user can enter manually
      }
    }
  }

  // Get clean install path (folder only, not batch file)
  const getInstallFolder = (installPath: string | undefined): string => {
    if (!installPath) return ''
    // If path ends with a script/executable, get the parent folder
    if (isCustomLauncherPath(installPath)) {
      const lastSlash = Math.max(installPath.lastIndexOf('\\'), installPath.lastIndexOf('/'))
      return lastSlash > 0 ? installPath.substring(0, lastSlash) : installPath
    }
    return installPath
  }

  const handleAddExistingServer = async () => {
    if (!canServersManage) return
    // For remote servers, only need name, rcon credentials
    if (addMode === 'remote') {
      if (!newServer.name.trim()) {
        toast({ title: t('toasts.error'), description: t('toasts.serverNameRequired'), variant: 'destructive' })
        return
      }
      if (!newServer.rconHost.trim()) {
        toast({ title: t('toasts.error'), description: t('toasts.rconHostRequired'), variant: 'destructive' })
        return
      }
      if (!newServer.rconPassword.trim()) {
        toast({ title: t('toasts.error'), description: t('toasts.rconPasswordRequired'), variant: 'destructive' })
        return
      }
    } else {
      // Local server validation
      if (!selectedServerConfig) {
        toast({ title: t('toasts.error'), description: t('toasts.detectFirst'), variant: 'destructive' })
        return
      }
      if (!newServer.rconPassword.trim() && !importIniFrom) {
        toast({ title: t('toasts.error'), description: t('toasts.rconPasswordRequiredIni'), variant: 'destructive' })
        return
      }
    }

    if (!isValidPort(newServer.rconPort)) {
      toast({ title: t('toasts.error'), description: t('toasts.rconPortRangeError'), variant: 'destructive' })
      return
    }
    if (!isValidGamePort(newServer.serverPort)) {
      toast({ title: t('toasts.error'), description: t('toasts.gamePortRangeError'), variant: 'destructive' })
      return
    }
    if (!Number.isFinite(newServer.minMemory) || !Number.isFinite(newServer.maxMemory)) {
      toast({ title: t('toasts.error'), description: t('toasts.memoryRequiredError'), variant: 'destructive' })
      return
    }

    // 2026-08-31 quality-pass finding: Add Remote Server had no duplicate
    // detection at all -- resubmitting the identical name+host+port (a
    // double-click, or retrying after a page that looked unresponsive)
    // silently added another card indistinguishable from the first except
    // by an Inactive/Selected badge. Scoped to remote servers specifically
    // (where the finding was observed and where "same name, same host+port"
    // unambiguously means "the same server, registered twice") -- local
    // servers already validate against real install paths on the server
    // side and aren't part of this finding.
    if (addMode === 'remote') {
      const normalizedName = newServer.name.trim().toLowerCase()
      const normalizedHost = newServer.rconHost.trim().toLowerCase()
      const isDuplicate = (servers || []).some(s =>
        s.isRemote &&
        (s.name || s.serverName || '').trim().toLowerCase() === normalizedName &&
        (s.rconHost || '').trim().toLowerCase() === normalizedHost &&
        s.rconPort === newServer.rconPort
      )
      if (isDuplicate) {
        toast({
          title: t('toasts.error'),
          description: t('toasts.duplicateRemoteServer', { name: newServer.name.trim() }),
          variant: 'destructive',
        })
        return
      }
    }

    setAddingServer(true)
    try {
      // Local mode with a detected config that has an ini password and no
      // typed override: send a reference and let the server re-read the
      // password itself, instead of round-tripping it through this form
      // (which never held it in the first place -- /auto-scan and /detect
      // don't return it).
      const useIniImport =
        addMode === 'local' && !!importIniFrom && !newServer.rconPassword.trim()

      const createResult = await serversApi.create({
        name: newServer.name || newServer.serverName,
        serverName: newServer.serverName,
        installPath: newServer.installPath,
        zomboidDataPath: newServer.zomboidDataPath,
        serverConfigPath: newServer.serverConfigPath,
        rconHost: newServer.rconHost,
        rconPort: newServer.rconPort,
        ...(useIniImport ? { importIniFrom } : { rconPassword: newServer.rconPassword }),
        dockerContainerName: newServer.dockerContainerName || null,
        serverPort: newServer.serverPort,
        minMemory: newServer.minMemory,
        maxMemory: newServer.maxMemory,
        useNoSteam: newServer.useNoSteam,
        useDebug: newServer.useDebug,
        isRemote: addMode === 'remote'
      } as Partial<ServerInstance> & { importIniFrom?: { dataPath: string; serverName: string } })

      if (createResult.server?.id) {
        await serversApi.activate(createResult.server.id)
      }

      toast({ title: t('toasts.serverAddedTitle'), description: t('toasts.serverAddedDesc', { name: newServer.name }) })
      setShowAddDialog(false)
      setNewServer(defaultNewServer)
      setDetectResult(null)
      setDetectError(null)
      setSelectedServerConfig('')
      setImportIniFrom(null)
      fetchServers()
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.addServerFailed')),
        variant: 'destructive'
      })
    } finally {
      setAddingServer(false)
    }
  }

  const resetAddDialog = () => {
    setShowAddDialog(false)
    setNewServer(defaultNewServer)
    setDetectResult(null)
    setDetectError(null)
    setSelectedServerConfig('')
    setImportIniFrom(null)
    setAutoScanResult(null)
    setAutoScanPath('')
    setShowAutoScan(false)
    setAddMode('local')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6 page-transition">
      {/* Header */}
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        eyebrow={t('pageHeader.eyebrow')}
        tone="servers"
        icon={<Server className="w-5 h-5 text-primary" />}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <DisabledReason reason={!canServersDiscover ? t('pageHeader.scanNoPermission') : null}>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={handleScanMounts}
                disabled={scanningMounts || !canServersDiscover}
                aria-label={t('pageHeader.scanAria')}
                // eslint-disable-next-line local/no-dead-disabled-title -- pure hint, same text as the aria-label; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                title={t('pageHeader.scanTitle')}
              >
                {scanningMounts ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Search className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            </DisabledReason>
            <Button variant="outline" onClick={() => { setAddMode('remote'); setShowAddDialog(true) }}>
              <Globe className="w-4 h-4 me-2" /> {t('pageHeader.addRemote')}
            </Button>
            <Button variant="outline" onClick={() => { setAddMode('local'); setShowAddDialog(true) }}>
              <FolderOpen className="w-4 h-4 me-2" /> {t('pageHeader.addExisting')}
            </Button>
            <Button variant="command" onClick={() => navigate('/server-setup')}>
              <Download className="w-4 h-4 me-2" /> {t('pageHeader.installNew')}
            </Button>
          </div>
        }
      />

      {fetchError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('fetchError.title')}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 break-words" dir="auto">{fetchError}</span>
            <Button variant="outline" size="sm" onClick={() => fetchServers({ manual: true })} className="self-start">
              <RefreshCw className="me-2 h-4 w-4" /> {t('fetchError.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Discovered mounts — offer a one-click connect when no server profile
          uses them yet. 2026-09-09 ruling (god): shown on EVERY visit, not
          just the empty-roster first-server screen -- the fetch behind this
          already runs unconditionally on every page load (see the effect
          above), so gating the display on serversConfirmedEmpty meant we
          did the work and threw the answer away for anyone adding a second
          server. */}
      {(readyCandidates.length > 0 || reviewCandidates.length > 0 || inaccessibleCandidates.length > 0) && (
        <div className="space-y-2">
          {readyCandidates.map(candidate => (
            <MountDiscoveryBanner
              key={candidate.installPath}
              mount={candidateToDiscoveredMount(candidate)}
              confidence="confirmed"
              onConnect={setDiscoverySetupMount}
            />
          ))}
          {reviewCandidates.map(candidate => (
            <MountDiscoveryBanner
              key={candidate.installPath || candidate.dataPath}
              mount={candidateToDiscoveredMount(candidate)}
              confidence="partial"
              reason={candidate.reason}
              onConnect={() => handleReviewCandidateConnect(candidate)}
            />
          ))}
          {inaccessibleCandidates.map(candidate => (
            <InaccessibleMountBanner
              key={candidate.installPath || candidate.dataPath}
              entry={{
                path: candidate.installPath || candidate.dataPath || '',
                source: candidate.source,
                reason: candidate.reason,
              }}
              onRetry={handleScanMounts}
            />
          ))}
        </div>
      )}

      {/* Server Grid — a confirmed-empty roster gets the onboarding card; an
          unknown roster (still loading past the initial spinner, or the last
          fetch failed) renders neither that nor a stale grid, only the alert
          above. */}
      {serversConfirmedEmpty ? (
        <Card className="mission-brief overflow-hidden border-primary/20 bg-card">
          <CardContent className="py-10">
            <div className="mx-auto max-w-4xl space-y-8">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
                  <Server className="h-7 w-7" />
                </div>
                <h3 className="text-xl font-semibold text-foreground">{t('emptyState.title')}</h3>
                <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {t('emptyState.description')}
                </p>
              </div>

              <div className="mission-step-grid grid gap-4 md:grid-cols-3">
                <div className="mission-step-card rounded-2xl border border-border/60 bg-background/40 p-5">
                  <div className="mission-step-icon mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <FolderOpen className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">{t('emptyState.addLocalTitle')}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t('emptyState.addLocalDesc')}
                  </p>
                  <Button variant="outline" className="onboarding-cta mt-4 w-full" onClick={() => { setAddMode('local'); setShowAddDialog(true) }}>
                    <FolderOpen className="me-2 h-4 w-4" />
                    {t('pageHeader.addExisting')}
                  </Button>
                </div>

                <div className="mission-step-card rounded-2xl border border-border/60 bg-background/40 p-5">
                  <div className="mission-step-icon mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <Download className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">{t('emptyState.installTitle')}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t('emptyState.installDesc')}
                  </p>
                  <Button className="onboarding-cta mt-4 w-full" onClick={() => navigate('/server-setup')}>
                    <Download className="me-2 h-4 w-4" />
                    {t('pageHeader.installNew')}
                  </Button>
                </div>

                <div className="mission-step-card rounded-2xl border border-border/60 bg-background/40 p-5">
                  <div className="mission-step-icon mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <Globe className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">{t('emptyState.connectRemoteTitle')}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t('emptyState.connectRemoteDesc')}
                  </p>
                  <Button variant="secondary" className="onboarding-cta mt-4 w-full" onClick={() => { setAddMode('remote'); setShowAddDialog(true) }}>
                    <Globe className="me-2 h-4 w-4" />
                    {t('pageHeader.addRemote')}
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 rounded-2xl border border-border/60 bg-background/30 p-5 md:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t('emptyState.step1Label')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{t('emptyState.step1Text')}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t('emptyState.step2Label')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{t('emptyState.step2Text')}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t('emptyState.step3Label')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{t('emptyState.step3Text')}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : servers && servers.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 stagger-in">
          {servers.map(server => {
            const hasUpdate = updateInfo?.updateAvailable && server.isActive
            // Never-succeeded is scoped to the active server, same as
            // hasUpdate above -- there is exactly one UpdateChecker instance
            // server-side, tracking whichever server is currently active.
            // Deliberately independent of lastError: a check that has never
            // run yet (both fields still at their initial null/false) must
            // read the same as one that has actively failed -- either way,
            // there is no real answer to show.
            const updateStatusUnknown = server.isActive && !updateCheckEverSucceeded
            return (
            <Card
              key={server.id}
              className={`relative overflow-hidden transition-colors ${
                server.isActive
                  ? 'border-primary/60 ring-1 ring-primary/25 bg-gradient-to-br from-primary/[0.04] via-card to-card'
                  : 'hover:border-primary/30'
              } ${hasUpdate ? 'border-warning/60' : ''}`}
            >
              {/* Active indicator bar — thicker gradient stripe when active */}
              {server.isActive && (
                <div className="absolute top-0 inset-x-0 h-[3px] bg-gradient-to-r from-primary via-primary/80 to-primary/40" aria-hidden="true" />
              )}
              {hasUpdate && !server.isActive && (
                <div className="absolute top-0 inset-x-0 h-[3px] bg-gradient-to-r from-warning via-warning/80 to-warning/40" aria-hidden="true" />
              )}

              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <CardTitle className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="truncate">{server.name}</span>
                      {server.isActive ? (
                        <Badge variant="default" className="text-xs">
                          <Check className="w-3 h-3 me-1" /> {t('card.selected')}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          {t('card.inactive')}
                        </Badge>
                      )}
                      {(() => {
                        // The selected server has real RCON/bridge signals from the
                        // composed status endpoint; every other card only knows
                        // whatever its own provider-appropriate source found for it
                        // (see the comment on serverStatuses above this component).
                        if (server.isActive && currentActiveStatus) {
                          return (
                            <ServerStatusBadge
                              compact
                              host={currentActiveStatus.host}
                              server={currentActiveStatus.server}
                              bridge={currentActiveStatus.bridge}
                            />
                          )
                        }
                        const provider = resolveClientProvider(server)
                        let host
                        if (server.isRemote) {
                          host = { status: 'unknown', label: t('card.statusHost') }
                        } else if (provider === 'docker-local') {
                          // GH#114: never read serverStatuses (the local process
                          // scan) for a docker-mapped server -- it can't see a
                          // process in a different container. dockerContainers is
                          // already fetched in bulk for the whole page, so this is
                          // a lookup against existing state, not a per-card fetch.
                          const container = dockerContainers.find(
                            (item) => item.name === server.dockerContainerName || item.id === server.dockerContainerName,
                          )
                          const dockerHostStatus = resolveDockerCardHostStatus(dockerAvailable, container)
                          host = dockerHostStatus === 'unknown'
                            ? { status: 'unknown', label: t('card.statusContainer'), detail: t('card.statusUnavailable') }
                            : { status: dockerHostStatus, label: t('card.statusContainer') }
                        } else {
                          const status = serverStatuses[String(server.id)]
                          // stateUnknown (server/routes/servers.js's GET /status,
                          // see the ServerStatusEntry comment in lib/serverStatus.ts)
                          // must not collapse into a confident running/stopped here
                          // -- this is the exact "the server said unknown, the badge
                          // said stopped" gap resolveServerCardRunning below already
                          // guards for button enablement; the badge had its own,
                          // separate collapse (2026-09-08 three-state audit).
                          host = status
                            ? status.stateUnknown
                              ? { status: 'unknown', label: t('card.statusProcess'), detail: t('card.statusUnavailable') }
                              : { status: status.running ? 'running' : 'stopped', label: t('card.statusProcess') }
                            : undefined
                        }
                        const rconStatus = rconStatuses[String(server.id)]
                        const rcon = rconStatus
                          ? rconStatus === 'connected'
                            ? { status: 'connected', label: t('card.rcon') }
                            : rconStatus === 'unconfigured'
                              ? { status: 'unknown', label: t('card.rcon'), detail: t('card.statusNotConfigured') }
                              : { status: 'disconnected', label: t('card.rcon'), detail: rconStatus === 'auth_failed' ? t('card.statusAuthFailed') : t('card.statusUnavailable') }
                          : undefined
                        return <ServerStatusBadge compact host={host} server={rcon} />
                      })()}
                      {server.isRemote && (
                        <Badge variant="outline" className="text-xs">
                          <Globe className="w-3 h-3 me-1" /> {t('card.remote')}
                        </Badge>
                      )}
                      {hasUpdate && (
                        <Badge variant="warning" className="text-xs">
                          <RefreshCw className="w-3 h-3 me-1" /> {t('card.updateAvailable')}
                        </Badge>
                      )}
                      {updateStatusUnknown && (
                        <Badge
                          variant="outline"
                          className="text-xs text-muted-foreground"
                          title={updateCheckLastError ?? undefined}
                        >
                          <AlertCircle className="w-3 h-3 me-1" /> {t('card.updateStatusUnknown')}
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="font-mono text-xs">
                      {server.serverName}
                    </CardDescription>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="iconDense" className="shrink-0" aria-label={t('card.optionsAria', { name: server.name || server.serverName })}>
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditingServer({ ...server })}>
                        <Edit2 className="w-4 h-4 me-2" /> {t('card.edit')}
                      </DropdownMenuItem>
                      {!server.isActive && (
                        <DisabledReason reason={!canServersManage ? t('card.noPermissionManage') : null} className="w-full">
                          <DropdownMenuItem onClick={() => handleActivateServer(server)} disabled={activating !== null || !canServersManage}>
                            <Power className="w-4 h-4 me-2" /> {t('card.setActive')}
                          </DropdownMenuItem>
                        </DisabledReason>
                      )}
                      {!server.isRemote && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => openSteamOperation(server, 'update')}>
                            <RefreshCw className="w-4 h-4 me-2" /> {t('card.updateServer')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openSteamOperation(server, 'verify')}>
                            <ShieldCheck className="w-4 h-4 me-2" /> {t('card.verifyFiles')}
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => setDeleteServer(server)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="w-4 h-4 me-2" /> {t('card.removeFromPanel')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                {/* Paths Section */}
                {!server.isRemote && (server.installPath || server.zomboidDataPath) && (
                  <div className="rounded-md border border-border/40 bg-muted/15 divide-y divide-border/30">
                    {server.installPath && (
                      <div className="flex items-start gap-2.5 px-3 py-2">
                        <HardDrive className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('card.installPath')}</p>
                          <p className="font-mono text-xs text-foreground/85 truncate mt-0.5" title={server.installPath}>{server.installPath}</p>
                        </div>
                      </div>
                    )}
                    {server.zomboidDataPath && (
                      <div className="flex items-start gap-2.5 px-3 py-2">
                        <Database className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('card.dataPath')}</p>
                          <p className="font-mono text-xs text-foreground/85 truncate mt-0.5" title={server.zomboidDataPath}>{server.zomboidDataPath}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {(() => {
                  const container = server.dockerContainerName
                    ? dockerContainers.find((item) => item.name === server.dockerContainerName || item.id === server.dockerContainerName)
                    : null
                  if (!shouldShowDockerCardActions(container)) return null
                  const stats = dockerStats[container.id] || dockerStats[container.name]
                  const isRunning = container.state === 'running'
                  const pending = dockerActionPending !== null
                  return (
                    <div className="space-y-2 border-y border-border/50 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <Container className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate text-xs font-medium">{container.name}</span>
                          <span className={cn('text-xs', isRunning ? 'text-muted-foreground' : 'text-destructive')}>
                            {container.state}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <DisabledReason reason={!canDockerManage ? t('card.noPermissionDocker') : null}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="iconDense" variant="ghost" disabled={pending || isRunning || !canDockerManage} onClick={() => handleDockerAction(container, 'start')} aria-label={t('card.startContainerAria', { name: container.name })}>
                                {dockerActionPending === `start-${container.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('card.startContainer')}</TooltipContent>
                          </Tooltip>
                          </DisabledReason>
                          <DisabledReason reason={!canDockerManage ? t('card.noPermissionDocker') : null}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="iconDense" variant="ghost" disabled={pending || !isRunning || !canDockerManage} onClick={async () => {
                                // Traced via Dwight: this route saves via RCON first and
                                // refuses outright if that save fails (stricter than plain
                                // process Stop), but the actual termination is Docker
                                // SIGTERM-then-SIGKILL, not RCON's own graceful quit -- so
                                // unlike plain Stop, it CAN end in a forced kill. Closer to
                                // Force Stop's tier than plain Stop's, hence red + confirm
                                // here despite the ghost/icon-only styling everywhere else
                                // on this row.
                                const ok = await confirm({
                                  title: t('card.stopContainerConfirmTitle'),
                                  description: t('card.stopContainerConfirmDescription', { name: container.name }),
                                  confirmLabel: t('card.stopContainer'),
                                })
                                if (!ok) return
                                handleDockerAction(container, 'stop')
                              }} aria-label={t('card.stopContainerAria', { name: container.name })}>
                                {dockerActionPending === `stop-${container.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4 text-destructive" />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('card.stopContainer')}</TooltipContent>
                          </Tooltip>
                          </DisabledReason>
                          <DisabledReason reason={!canDockerManage ? t('card.noPermissionDocker') : null}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="iconDense" variant="ghost" disabled={pending || !canDockerManage} onClick={() => handleDockerAction(container, 'restart')} aria-label={t('card.restartContainerAria', { name: container.name })}>
                                {dockerActionPending === `restart-${container.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('card.restartContainer')}</TooltipContent>
                          </Tooltip>
                          </DisabledReason>
                        </div>
                      </div>
                      {stats && (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                          <span className="text-muted-foreground">{t('card.cpu')} <span className="font-mono text-foreground">{stats.cpuPercent}%</span></span>
                          <span className="text-muted-foreground">{t('card.ram')} <span className="font-mono text-foreground">{formatBytes(stats.memoryUsed)} ({stats.memoryPercent}%)</span></span>
                          <span className="text-muted-foreground">{t('card.net')} <span className="font-mono text-foreground">{formatBytes(stats.networkRx)} {t('card.netIn')}</span></span>
                          <span className="text-muted-foreground">{t('card.disk')} <span className="font-mono text-foreground">{formatBytes(stats.diskWrite)} {t('card.diskWrite')}</span></span>
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* Network & Config Grid */}
                <div className={`grid ${server.isRemote ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'} gap-2`}>
                  <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
                    <div className="grid place-items-center w-7 h-7 rounded-md border border-primary/25 bg-primary/[0.06] text-primary shrink-0" aria-hidden="true">
                      <Network className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('card.rcon')}</p>
                      <p className="font-mono text-xs text-foreground/90 truncate tabular-nums">{server.rconHost}:{server.rconPort}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
                    <div className="grid place-items-center w-7 h-7 rounded-md border border-primary/25 bg-primary/[0.06] text-primary shrink-0" aria-hidden="true">
                      <Globe className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('card.gamePort')}</p>
                      <p className="font-mono text-xs text-foreground/90 tabular-nums">{server.serverPort}</p>
                    </div>
                  </div>
                  {!server.isRemote && (
                    <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
                      <div className="grid place-items-center w-7 h-7 rounded-md border border-border/55 bg-muted/40 text-muted-foreground shrink-0" aria-hidden="true">
                        <Cpu className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('card.memory')}</p>
                        {/* bug-hunt-2026-09-08 (Arabic render pass): confirmed
                            reversed in a real render (a 2-4 GB server showed
                            "4-2") -- bdi isolates the min-max pair regardless
                            of locale. */}
                        <p className="font-mono text-xs text-foreground/90 tabular-nums"><bdi>{server.minMemory}–{server.maxMemory} GB</bdi></p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Branch & Build Info (if update info available for active server) */}
                {server.isActive && (updateInfo || gameVersion) && (
                  <div className="p-2.5 rounded-md bg-muted/50 border border-border/50">
                    <div className="flex items-center justify-between flex-wrap gap-y-1">
                      <div className="flex items-center gap-2">
                        {gameVersion && (
                          <Badge variant="outline" className="text-xs font-mono">v{gameVersion}</Badge>
                        )}
                        {updateInfo && (
                          <>
                            <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
                            <Badge variant="secondary" className="text-xs font-mono">{updateInfo.installed.branch}</Badge>
                          </>
                        )}
                      </div>
                      {updateInfo && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground">{t('card.buildLabel')}</span>
                          <span className="font-mono font-medium">{updateInfo.installed.buildId}</span>
                          {updateInfo.updateAvailable && (
                            <>
                              <ArrowRight className="w-3 h-3 text-warning" />
                              <span className="font-mono font-semibold text-warning">{updateInfo.latest.buildId}</span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Server branch badge for non-active */}
                {!server.isActive && server.branch && (
                  <div className="flex items-center gap-2">
                    <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">{t('card.branchLabel')}</span>
                    <Badge variant="secondary" className="text-xs font-mono">{server.branch}</Badge>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex flex-wrap gap-2 pt-1">
                  {(() => {
                    const status = serverStatuses[String(server.id)]
                    const isRunning = resolveServerCardRunning(server, status, currentActiveStatus)
                    const startPending = serverActionPending === `start-${server.id}`
                    const stopPending = serverActionPending === `stop-${server.id}`
                    const hasManagedContainer = dockerAvailable && server.dockerContainerName && dockerContainers.some((item) => item.name === server.dockerContainerName || item.id === server.dockerContainerName)
                    if (server.isRemote || hasManagedContainer) return null
                    if (isRunning === null) {
                      return (
                        <DisabledReason reason={!canInlineStartStop ? t('card.noPermissionStartStop') : t('card.statusUnavailable')}>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled
                            title={t('card.statusUnavailable')}
                          >
                            <Loader2 className="w-4 h-4 me-1.5 animate-spin" /> {t('card.start')}
                          </Button>
                        </DisabledReason>
                      )
                    }
                    return isRunning ? (
                      <DisabledReason reason={!canInlineStartStop ? t('card.noPermissionStartStop') : null}>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleInlineStop(server)}
                          disabled={stopPending || serverActionPending !== null || !canInlineStartStop}
                          // eslint-disable-next-line local/no-dead-disabled-title -- pure hint; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                          title={t('card.stopThisServer')}
                        >
                          {stopPending ? (
                            <><Loader2 className="w-4 h-4 me-1.5 animate-spin" /> {t('card.stopping')}</>
                          ) : (
                            <><Square className="w-4 h-4 me-1.5" /> {t('card.stop')}</>
                          )}
                        </Button>
                      </DisabledReason>
                    ) : (
                      <DisabledReason reason={!canInlineStartStop ? t('card.noPermissionStartStop') : null}>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleInlineStart(server)}
                          disabled={startPending || serverActionPending !== null || !canInlineStartStop}
                          // eslint-disable-next-line local/no-dead-disabled-title -- pure hint (which of two enabled-state labels applies); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                          title={server.isActive ? t('card.startThisServer') : t('card.switchAndStart')}
                        >
                          {startPending ? (
                            <><Loader2 className="w-4 h-4 me-1.5 animate-spin" /> {t('card.starting')}</>
                          ) : (
                            <><Play className="w-4 h-4 me-1.5" /> {t('card.start')}</>
                          )}
                        </Button>
                      </DisabledReason>
                    )
                  })()}
                  {server.isRemote && (
                    <div className="flex items-center gap-1">
                      <DisabledReason reason={!canServersManage ? t('card.noPermissionManage') : null}>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleConfigureRemoteBridge(server)}
                          disabled={!canServersManage}
                          // eslint-disable-next-line local/no-dead-disabled-title -- pure hint describing what the button does; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                          title={t('card.configureSftpTitle')}
                        >
                          <Link className="w-4 h-4 me-1.5" /> {t('card.configureSftp')}
                        </Button>
                      </DisabledReason>
                      <HelpTip label={t('card.configureSftp')}>{t('card.configureSftpTip')}</HelpTip>
                    </div>
                  )}
                  {hasUpdate && (
                    <Button
                      size="sm"
                      variant="warning"
                      onClick={() => openSteamOperation(server, 'update')}
                    >
                      <RefreshCw className="w-4 h-4 me-1.5" /> {t('card.updateNow')}
                    </Button>
                  )}
                  {!server.isActive && (
                    <DisabledReason reason={!canServersManage ? t('card.noPermissionManage') : null}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleActivateServer(server)}
                        disabled={activating === server.id || !canServersManage}
                      >
                        {activating === server.id ? (
                          <><Loader2 className="w-4 h-4 me-1.5 animate-spin" /> {t('card.activating')}</>
                        ) : (
                          <><Power className="w-4 h-4 me-1.5" /> {t('card.switchToThisServer')}</>
                        )}
                      </Button>
                    </DisabledReason>
                  )}
                </div>

                {/* Created date */}
                {server.createdAt && (
                  <p className="text-[11px] text-muted-foreground/60 pt-1">
                    {t('card.added', { date: new Date(server.createdAt).toLocaleDateString(i18n.language) })}
                  </p>
                )}
              </CardContent>
            </Card>
          )})}
        </div>
      ) : null}

      {/* Add Existing Server Dialog */}
      <Dialog open={showAddDialog} onOpenChange={(open) => !open && resetAddDialog()}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{addMode === 'remote' ? t('addDialog.titleRemote') : t('addDialog.titleLocal')}</DialogTitle>
            <DialogDescription>
              {addMode === 'remote'
                ? t('addDialog.descRemote')
                : t('addDialog.descLocal')}
            </DialogDescription>
          </DialogHeader>

          {addMode === 'local' && !!servers?.some(s => !s.isRemote) && (
            <div className="space-y-1.5 rounded-md border border-border/60 p-3">
              <p className="text-xs font-medium">{t('tandem.sectionTitle')}</p>
              <ul className="space-y-1">
                {[
                  [t('tandem.installFolderLabel'), t('tandem.installFolderValue')],
                  [t('tandem.dataFolderLabel'), t('tandem.dataFolderValue')],
                  [t('tandem.configNameLabel'), t('tandem.configNameValue')],
                  [t('tandem.gamePortLabel'), t('tandem.gamePortValue')],
                  [t('tandem.rconPortLabel'), t('tandem.rconPortValue')],
                  [t('tandem.steamcmdLabel'), t('tandem.steamcmdValue')],
                ].map(([k, v]) => (
                  <li key={k} className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-2 text-xs">
                    <span className="text-muted-foreground">{k}</span>
                    <span>{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Mode Selector */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => { setAddMode('local'); setNewServer(defaultNewServer); setDetectResult(null); setDetectError(null); setSelectedServerConfig(''); setImportIniFrom(null) }}
              className={`flex items-center gap-3 p-3 rounded-lg border-2 transition-[background-color,border-color,color] ${
                addMode === 'local'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/30'
              }`}
            >
              <Monitor className={`w-5 h-5 ${addMode === 'local' ? 'text-primary' : 'text-muted-foreground'}`} />
              <div className="text-start">
                <p className="text-sm font-medium">{t('addDialog.modeLocalTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('addDialog.modeLocalDesc')}</p>
              </div>
            </button>
            <button
              onClick={() => { setAddMode('remote'); setNewServer({ ...defaultNewServer, isRemote: true, rconHost: '' }); setDetectResult(null); setDetectError(null); setSelectedServerConfig(''); setImportIniFrom(null) }}
              className={`flex items-center gap-3 p-3 rounded-lg border-2 transition-[background-color,border-color,color] ${
                addMode === 'remote'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/30'
              }`}
            >
              <Globe className={`w-5 h-5 ${addMode === 'remote' ? 'text-primary' : 'text-muted-foreground'}`} />
              <div className="text-start">
                <p className="text-sm font-medium">{t('addDialog.modeRemoteTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('addDialog.modeRemoteDesc')}</p>
              </div>
            </button>
          </div>

          {/* Remote Server Info Banner */}
          {addMode === 'remote' && (
            <Alert className="border-primary/20 bg-primary/5">
              <Wifi className="h-4 w-4 text-primary" />
              <AlertTitle>{t('addDialog.rconOnlyTitle')}</AlertTitle>
              <AlertDescription>
                {t('addDialog.rconOnlyDesc')}
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-4 py-2">
            {addMode === 'remote' ? (
              /* ========== REMOTE SERVER FORM ========== */
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('remoteForm.displayNameLabel')}</Label>
                  <Input
                    value={newServer.name}
                    onChange={e => setNewServer({ ...newServer, name: e.target.value })}
                    placeholder={t('remoteForm.displayNamePlaceholder')}
                    maxLength={64}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('remoteForm.hostLabel')}</Label>
                    <Input
                      value={newServer.rconHost}
                      onChange={e => setNewServer({ ...newServer, rconHost: e.target.value })}
                      placeholder={t('remoteForm.hostPlaceholder')}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">{t('remoteForm.hostHint')}</p>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('remoteForm.rconPortLabel')}</Label>
                    <NumberInput
                      value={newServer.rconPort}
                      onChange={rconPort => setNewServer({ ...newServer, rconPort })}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>{t('remoteForm.rconPasswordLabel')}</Label>
                  <PasswordInput
                    value={newServer.rconPassword}
                    onChange={value => setNewServer({ ...newServer, rconPassword: value })}
                    placeholder={t('remoteForm.rconPasswordPlaceholder')}
                    label={t('remoteForm.rconPasswordAria')}
                  />
                  <RconTestConnection
                    host={newServer.rconHost}
                    port={newServer.rconPort}
                    password={newServer.rconPassword}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t('remoteForm.gamePortLabel')}</Label>
                  <NumberInput
                    min={1}
                    max={65534}
                    value={newServer.serverPort}
                    onChange={serverPort => setNewServer({ ...newServer, serverPort })}
                  />
                  <p className="text-xs text-muted-foreground">{t('remoteForm.gamePortHint')}</p>
                </div>
              </div>
            ) : (
              /* ========== LOCAL SERVER FORM ========== */
              <>
            {/* Auto Scan Section */}
            <div className="p-4 rounded-lg bg-muted/50 border space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{t('localForm.autoDetectTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('localForm.autoDetectDesc')}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAutoScan(!showAutoScan)}
                >
                  {showAutoScan ? t('localForm.manualEntry') : t('localForm.autoScan')}
                </Button>
              </div>

              {showAutoScan && (
                <div className="space-y-3 pt-2">
                  <div className="flex gap-2">
                    <Input
                      value={autoScanPath}
                      onChange={e => setAutoScanPath(e.target.value)}
                      placeholder={t('localForm.scanPathPlaceholder')}
                      className="font-mono text-sm flex-1"
                    />
                    <DisabledReason reason={!canServersDiscover ? t('localForm.discoverNoPermission') : null}>
                      <Button
                        onClick={handleAutoScan}
                        disabled={autoScanning || !autoScanPath.trim() || !canServersDiscover}
                      >
                        {autoScanning ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <><Search className="w-4 h-4 me-1" /> {t('localForm.scan')}</>
                        )}
                      </Button>
                    </DisabledReason>
                  </div>

                  {/* Auto Scan Results */}
                  {autoScanResult && autoScanResult.detectedConfigs.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {t('localForm.foundServers', { count: autoScanResult.detectedConfigs.length })}
                      </p>
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {autoScanResult.detectedConfigs.map((config, idx) => (
                          <button
                            type="button"
                            key={config.serverName || idx}
                            className="w-full text-start p-3 rounded border bg-background hover:bg-accent cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                            onClick={() => handleSelectScannedConfig(config, autoScanResult.installPaths[0])}
                            aria-label={t('localForm.selectScannedConfigAria', { name: config.publicName || config.serverName })}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-medium">{config.publicName || config.serverName}</span>
                              <Badge variant="secondary" className="text-xs font-mono">
                                {config.serverName}.ini
                              </Badge>
                            </div>
                            <div className="text-xs text-muted-foreground mt-1 font-mono truncate">
                              {t('localForm.dataPrefix', { path: config.dataPath })}
                            </div>
                            {config.matchedBatFile ? (
                              <div className="mt-1 text-xs font-mono text-primary truncate">
                                {t('localForm.matchedPrefix', { path: config.matchedBatFile })}
                              </div>
                            ) : autoScanResult.installPaths.length > 0 ? (
                              <div className="mt-1 text-xs text-warning">
                                {t('localForm.noMatchingScript')}
                              </div>
                            ) : (
                              <div className="mt-1 text-xs text-warning">
                                {t('localForm.noInstallPath')}
                              </div>
                            )}
                          </button>
                        ))}
                      </div>

                      {/* Show available paths summary */}
                      <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                        {autoScanResult.installPaths.length > 0 && (
                          <p>{t('localForm.installPathsFound', { count: autoScanResult.installPaths.length })}</p>
                        )}
                        {autoScanResult.customBatFiles && autoScanResult.customBatFiles.length > 0 && (
                          <p>{t('localForm.customScripts', { names: autoScanResult.customBatFiles.map(b => b.fileName).join(', ') })}</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Manual Entry Section */}
            {!showAutoScan && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t('localForm.dataPathLabel')}</Label>
                <div className="flex gap-2">
                  <Input
                    value={newServer.zomboidDataPath}
                    onChange={e => {
                      setNewServer({ ...newServer, zomboidDataPath: e.target.value })
                      setDetectResult(null)
                      setDetectError(null)
                      setImportIniFrom(null)
                    }}
                    placeholder={t('localForm.dataPathPlaceholder')}
                    className="font-mono text-sm flex-1"
                    maxLength={260}
                  />
                  <DisabledReason reason={!canServersDiscover ? t('localForm.discoverNoPermission') : null}>
                    <Button
                      variant="secondary"
                      onClick={handleDetectServer}
                      disabled={detecting || !newServer.zomboidDataPath.trim() || !canServersDiscover}
                    >
                      {detecting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <><Search className="w-4 h-4 me-1" /> {t('localForm.detect')}</>
                      )}
                    </Button>
                  </DisabledReason>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('localForm.dataPathHint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label>{t('localForm.installPathLabel')}</Label>
                <Input
                  value={newServer.installPath}
                  onChange={e => setNewServer({ ...newServer, installPath: e.target.value })}
                  placeholder={t(platformTranslationKey('localForm.installPathPlaceholder', runtimeInfo?.family))}
                  className="font-mono text-sm"
                  maxLength={260}
                />
                {isCustomLauncherPath(newServer.installPath) && (
                  <Alert className="border-warning/40 bg-warning/10">
                    <AlertCircle className="h-4 w-4 text-warning" />
                    <AlertTitle className="text-warning">{t('localForm.customLauncherNoticeTitle')}</AlertTitle>
                    <AlertDescription>{t('localForm.customLauncherNoticeBody')}</AlertDescription>
                  </Alert>
                )}
              </div>
            </div>
            )}

            {/* Detection Error */}
            {detectError && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive">
                <AlertCircle className="w-4 h-4" />
                <span className="text-sm">{detectError}</span>
              </div>
            )}

            {/* Detection Result */}
            {detectResult && (
              <div className="space-y-4">
                {detectResult.detectedServers.length === 0 ? (
                  <Alert className="border-warning/40 bg-warning/10">
                    <AlertCircle className="h-4 w-4 text-warning" />
                    <AlertTitle className="text-warning">{t('localForm.noConfigsFoundTitle')}</AlertTitle>
                    <AlertDescription>{t('localForm.noConfigsFoundDesc')}</AlertDescription>
                  </Alert>
                ) : (
                  <>
                    {/* Server Selection (if multiple) */}
                    {detectResult.detectedServers.length > 1 && (
                      <div className="space-y-2">
                        <Label>{t('localForm.selectConfigLabel')}</Label>
                        <Select
                          value={selectedServerConfig}
                          onValueChange={(val) => {
                            const config = detectResult.detectedServers.find(s => s.serverName === val)
                            if (config) handleSelectServerConfig(config)
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t('localForm.selectConfigPlaceholder')} />
                          </SelectTrigger>
                          <SelectContent>
                            {detectResult.detectedServers.map(s => (
                              <SelectItem key={s.serverName} value={s.serverName}>
                                {s.publicName || s.serverName} ({s.serverName}.ini)
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* Detected Settings Summary */}
                    {selectedServerConfig && (
                      <div className="space-y-3 rounded-lg border bg-muted/50 p-4">
                        <div className="mb-3 flex items-center gap-2 text-primary">
                          <CheckCircle className="w-4 h-4" />
                          <span className="font-medium">{t('localForm.detectedTitle')}</span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                          <div>
                            <span className="text-muted-foreground">{t('localForm.serverNameLabel')}</span>
                            <p className="font-medium">{newServer.name}</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">{t('localForm.configFileLabel')}</span>
                            <p className="font-mono">{newServer.serverName}.ini</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">{t('localForm.gamePortLabel')}</span>
                            <p className="font-mono">{newServer.serverPort}</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">{t('localForm.rconPortLabel')}</span>
                            <p className="font-mono">{newServer.rconPort}</p>
                          </div>
                        </div>

                        {tandemConflicts.length > 0 && (
                          <div className="space-y-1.5 rounded-md border border-destructive/50 bg-destructive/5 p-3">
                            <p className="text-xs font-medium text-destructive">
                              {t('tandem.conflictsTitle')}
                            </p>
                            <ul className="space-y-1">
                              {tandemConflicts.map((c: { label: string; detail: string }, i: number) => (
                                <li key={`${c.label}-${i}`} className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-2 text-xs">
                                  <span className="text-muted-foreground">{c.label}</span>
                                  <span>{c.detail}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* RCON Password Section */}
                        <div className="space-y-2 mt-2">
                          <Label>{t('localForm.rconPasswordLabel')}</Label>
                          <PasswordInput
                            placeholder={importIniFrom ? t('localForm.rconPasswordImportPlaceholder') : t('localForm.rconPasswordPlaceholder')}
                            value={newServer.rconPassword}
                            className="bg-background"
                            onChange={value => {
                              setNewServer({ ...newServer, rconPassword: value })
                              setImportIniFrom(null)
                            }}
                            label={t('localForm.rconPasswordAria')}
                          />
                          {!newServer.rconPassword && importIniFrom ? (
                            <p className="flex items-center gap-1 text-xs text-primary">
                              <CheckCircle className="w-3 h-3" /> {t('localForm.passwordWillImport', { iniName: newServer.serverName })}
                            </p>
                          ) : !newServer.rconPassword ? (
                            <p className="text-xs text-warning">
                              <Trans
                                i18nKey="localForm.rconPasswordRequired"
                                t={t}
                                values={{ iniName: newServer.serverName }}
                                components={{ 1: <code className="rounded bg-warning/20 px-1" /> }}
                              />
                            </p>
                          ) : (
                            <p className="flex items-center gap-1 text-xs text-primary">
                              <CheckCircle className="w-3 h-3" /> {t('localForm.passwordSet')}
                            </p>
                          )}
                          <RconTestConnection
                            host={newServer.rconHost || '127.0.0.1'}
                            port={newServer.rconPort}
                            password={newServer.rconPassword}
                          />
                        </div>

                        {/* Memory Configuration */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                          <div className="space-y-2">
                            <Label>{t('localForm.minMemoryLabel')}</Label>
                            <NumberInput
                              min={1}
                              max={64}
                              value={newServer.minMemory}
                              className="bg-background"
                              clamp={n => Math.max(1, n)}
                              onChange={minMemory => setNewServer({ ...newServer, minMemory })}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>{t('localForm.maxMemoryLabel')}</Label>
                            <NumberInput
                              min={1}
                              max={64}
                              value={newServer.maxMemory}
                              className="bg-background"
                              clamp={n => Math.max(1, n)}
                              onChange={maxMemory => setNewServer({ ...newServer, maxMemory })}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={resetAddDialog}>
              {t('addDialog.cancel')}
            </Button>
            <DisabledReason reason={!canServersManage ? t('addDialog.noPermission') : null}>
              <Button
                onClick={handleAddExistingServer}
                disabled={addingServer || !canServersManage || (addMode === 'local' ? (!selectedServerConfig || (!newServer.rconPassword && !importIniFrom)) : (!newServer.name || !newServer.rconHost || !newServer.rconPassword))}
              >
                {addingServer ? (
                  <><Loader2 className="w-4 h-4 me-2 animate-spin" /> {t('addDialog.adding')}</>
                ) : (
                  <><Plus className="w-4 h-4 me-2" /> {t('addDialog.addServer')}</>
                )}
              </Button>
            </DisabledReason>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editingServer} onOpenChange={() => setEditingServer(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('editDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('editDialog.description')}
            </DialogDescription>
          </DialogHeader>

          {editingServer && (
            <div className="space-y-4">
              {/* Remote server indicator */}
              {editingServer.isRemote && (
                <Alert className="border-primary/20 bg-primary/5">
                  <Globe className="h-4 w-4 text-primary" />
                  <AlertTitle>{t('editDialog.remoteTitle')}</AlertTitle>
                  <AlertDescription>{t('editDialog.remoteDesc')}</AlertDescription>
                </Alert>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('editDialog.displayNameLabel')}</Label>
                  <Input
                    value={editingServer.name}
                    onChange={e => setEditingServer({ ...editingServer, name: e.target.value })}
                    maxLength={100}
                    aria-invalid={editDuplicateRemoteConflict}
                    className={editDuplicateRemoteConflict ? 'border-destructive/70' : ''}
                  />
                  {editDuplicateRemoteConflict && (
                    <p className="text-xs text-destructive">{t('editDialog.duplicateRemoteServerHint')}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label>{t('editDialog.serverNameLabel')}</Label>
                    <HelpTip label={t('editDialog.serverNameLabel')}>{t('editDialog.serverNameTip')}</HelpTip>
                  </div>
                  <Input
                    value={editingServer.serverName}
                    onChange={e => setEditingServer({ ...editingServer, serverName: e.target.value })}
                    maxLength={64}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('editDialog.dockerContainerLabel')}</Label>
                  {(() => {
                    // 2026-09-09 ruling (god), rule 3: pick from the containers
                    // already loaded on this page instead of typing blind --
                    // but fall back to the plain input when there's nothing to
                    // pick from, or the stored value doesn't match anything
                    // currently visible (a container that isn't running right
                    // now, or Docker itself unreachable), so an existing,
                    // working configuration is never silently blanked out.
                    const currentMatchesKnown = dockerContainers.some(
                      (c) => c.name === editingServer.dockerContainerName || c.id === editingServer.dockerContainerName,
                    )
                    const autoManual =
                      dockerContainers.length === 0 ||
                      (!!editingServer.dockerContainerName && !currentMatchesKnown)
                    const showManualInput = dockerContainerManualOverride ?? autoManual

                    if (showManualInput) {
                      return (
                        <>
                          <Input
                            value={editingServer.dockerContainerName || ''}
                            onChange={e => setEditingServer({ ...editingServer, dockerContainerName: e.target.value || null })}
                            placeholder={t('editDialog.dockerContainerPlaceholder')}
                            maxLength={128}
                          />
                          {dockerContainers.length > 0 && (
                            <button
                              type="button"
                              className="text-xs text-primary underline underline-offset-2"
                              onClick={() => setDockerContainerManualOverride(false)}
                            >
                              {serversFallback('editDialog.dockerContainerPickInstead', 'Pick from detected containers instead')}
                            </button>
                          )}
                        </>
                      )
                    }

                    return (
                      <Select
                        value={editingServer.dockerContainerName || ''}
                        onValueChange={(value) => {
                          if (value === '__manual__') {
                            setDockerContainerManualOverride(true)
                            return
                          }
                          setEditingServer({ ...editingServer, dockerContainerName: value })
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={serversFallback('editDialog.dockerContainerPickPlaceholder', 'Select a container...')} />
                        </SelectTrigger>
                        <SelectContent>
                          {dockerContainers.map((c) => (
                            <SelectItem key={c.id} value={c.name || c.id}>
                              {c.name} <span className="text-muted-foreground">({c.state})</span>
                            </SelectItem>
                          ))}
                          <SelectItem value="__manual__">
                            {serversFallback('editDialog.dockerContainerTypeManually', 'Type it in manually...')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    )
                  })()}
                  <p className="text-xs text-muted-foreground">{t('editDialog.dockerContainerHint')}</p>
                </div>
              </div>

              {!editingServer.isRemote && (
              <>
              <div className="space-y-2">
                <Label>{t('editDialog.installPathLabel')}</Label>
                <Input
                  value={editingServer.installPath}
                  onChange={e => setEditingServer({ ...editingServer, installPath: e.target.value })}
                  className="font-mono text-sm"
                />
                {isCustomLauncherPath(editingServer.installPath) && (
                  <Alert className="border-warning/40 bg-warning/10">
                    <AlertCircle className="h-4 w-4 text-warning" />
                    <AlertTitle className="text-warning">{t('editDialog.customLauncherNoticeTitle')}</AlertTitle>
                    <AlertDescription>{t('editDialog.customLauncherNoticeBody')}</AlertDescription>
                  </Alert>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <Label>{t('editDialog.dataPathLabel')}</Label>
                  <HelpTip label={t('editDialog.dataPathLabel')}>{t('editDialog.dataPathTip')}</HelpTip>
                </div>
                <Input
                  value={editingServer.zomboidDataPath || ''}
                  onChange={e => setEditingServer({ ...editingServer, zomboidDataPath: e.target.value })}
                  className="font-mono text-sm"
                  placeholder={t('editDialog.dataPathPlaceholder')}
                />
              </div>

              {managedLifecycleSupported && !editingServer.dockerContainerName && !editingServer.dockerContainerId && (
                <div className="space-y-3 rounded-md border border-border/60 p-3">
                  <div className="space-y-1">
                    <Label>{t('editDialog.lifecycleProviderLabel')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('editDialog.lifecycleProviderHint')}
                    </p>
                  </div>
                  <Select
                    value={editingServer.lifecycleProvider || 'direct'}
                    onValueChange={(value: 'direct' | 'systemd' | 'openrc') =>
                      setEditingServer({ ...editingServer, lifecycleProvider: value })
                    }
                    disabled={lifecyclePending || !canServersManage}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="direct">{t('editDialog.lifecycleDirect')}</SelectItem>
                      <SelectItem value="systemd">systemd</SelectItem>
                      <SelectItem value="openrc">OpenRC</SelectItem>
                    </SelectContent>
                  </Select>
                  <Alert className="border-warning/40 bg-warning/10">
                    <AlertCircle className="h-4 w-4 text-warning" />
                    <AlertDescription>
                      {t('editDialog.lifecycleMigrationWarning')}
                    </AlertDescription>
                  </Alert>
                  <div className="flex flex-wrap gap-2">
                    {(editingServer.lifecycleProvider || 'direct') !== 'direct' && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={lifecyclePending || !canServersManage}
                        onClick={() => handleDownloadLifecycleTemplate(editingServer)}
                      >
                        {lifecyclePending ? (
                          <Loader2 className="me-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Download className="me-2 h-4 w-4" />
                        )}
                        {t('editDialog.lifecycleDownloadTemplate')}
                      </Button>
                    )}
                    {(editingServer.lifecycleProvider || 'direct') !==
                      (servers?.find((server) => server.id === editingServer.id)?.lifecycleProvider || 'direct') && (
                      <Button
                        type="button"
                        variant="warning"
                        size="sm"
                        disabled={lifecyclePending || !canServersManage}
                        onClick={() => handleActivateLifecycleProvider(editingServer)}
                      >
                        {lifecyclePending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                        {t('editDialog.lifecycleActivate')}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label className="flex items-center gap-1.5">
                  {t('editDialog.customStartCommandLabel')}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[280px]">
                      <p className="text-xs">{t('editDialog.customStartCommandTooltip')}</p>
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Input
                  value={editingServer.startCommand || ''}
                  onChange={e => setEditingServer({ ...editingServer, startCommand: e.target.value })}
                  className="font-mono text-sm"
                  placeholder={t(platformTranslationKey('editDialog.customStartCommandPlaceholder', runtimeInfo?.family))}
                  maxLength={1024}
                />
                {editingServer.startCommand && /[&|;<>`${}()!\[\]]/.test(editingServer.startCommand) && (
                  <p className="text-xs text-destructive">{t('editDialog.customStartCommandDisallowed')}</p>
                )}
              </div>
              <div className="flex items-start gap-3 rounded-md border border-border/60 p-3">
                <Checkbox
                  id={`edit-use-no-steam-${editingServer.id}`}
                  checked={!!editingServer.useNoSteam}
                  onCheckedChange={(checked) => setEditingServer({ ...editingServer, useNoSteam: checked === true })}
                />
                <div className="space-y-1">
                  <Label htmlFor={`edit-use-no-steam-${editingServer.id}`}>{t('editDialog.noSteamLabel')}</Label>
                  <p className="text-xs text-muted-foreground">{t('editDialog.noSteamHint')}</p>
                </div>
              </div>
              </>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    {editingServer.isRemote ? t('editDialog.rconHostLabelRemote') : t('editDialog.rconHostLabelLocal')}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[200px]">
                        <p className="text-xs">{t('editDialog.rconHostTooltip')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <Input
                    value={editingServer.rconHost}
                    onChange={e => setEditingServer({ ...editingServer, rconHost: e.target.value })}
                    placeholder={editingServer.isRemote ? t('editDialog.rconHostPlaceholderRemote') : t('editDialog.rconHostPlaceholderLocal')}
                    aria-invalid={editDuplicateRemoteConflict}
                    className={editDuplicateRemoteConflict ? 'border-destructive/70' : ''}
                  />
                  <p className={editDuplicateRemoteConflict ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                    {editDuplicateRemoteConflict
                      ? t('editDialog.duplicateRemoteServerHint')
                      : editingServer.isRemote
                        ? t('editDialog.rconHostHintRemote')
                        : t('editDialog.rconHostHintLocal')}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>{t('editDialog.rconPortLabel')}</Label>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={editingServer.rconPort}
                    onChange={e => {
                      const val = parseInt(e.target.value)
                      if (!isNaN(val)) setEditingServer({ ...editingServer, rconPort: Math.min(65535, Math.max(1, val)) })
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('editDialog.rconPasswordLabel')}</Label>
                  <PasswordInput
                    value={editingServer.rconPassword}
                    onChange={value => setEditingServer({ ...editingServer, rconPassword: value })}
                    label={t('editDialog.rconPasswordAria')}
                  />
                  <RconTestConnection
                    host={editingServer.rconHost}
                    port={editingServer.rconPort}
                    password={editingServer.rconPassword}
                  />
                </div>
                {!editingServer.isRemote && (
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    {t('editDialog.adminPasswordLabel')}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[240px]">
                        <p className="text-xs">{t('editDialog.adminPasswordTooltip')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <PasswordInput
                    value={editingServer.adminPassword || ''}
                    onChange={value => setEditingServer({ ...editingServer, adminPassword: value })}
                    placeholder={t('editDialog.adminPasswordPlaceholder')}
                    label={t('editDialog.adminPasswordAria')}
                  />
                </div>
                )}
              </div>

              <div className={editingServer.isRemote ? "grid grid-cols-1 gap-4" : "grid grid-cols-1 sm:grid-cols-3 gap-4"}>
                <div className="space-y-2">
                  <Label>{t('editDialog.gamePortLabel')}</Label>
                  <NumberInput
                    min={1}
                    max={65534}
                    value={editingServer.serverPort}
                    onChange={serverPort => setEditingServer({ ...editingServer, serverPort })}
                  />
                </div>
                {!editingServer.isRemote && (
                <>
                <div className="space-y-2">
                  <Label>{t('editDialog.minMemoryLabel')}</Label>
                  <NumberInput
                    min={1}
                    max={64}
                    value={editingServer.minMemory}
                    clamp={n => Math.max(1, n)}
                    onChange={minMemory => setEditingServer({ ...editingServer, minMemory })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('editDialog.maxMemoryLabel')}</Label>
                  <NumberInput
                    min={1}
                    max={64}
                    value={editingServer.maxMemory}
                    clamp={n => Math.max(1, n)}
                    onChange={maxMemory => setEditingServer({ ...editingServer, maxMemory })}
                  />
                </div>
                </>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingServer(null)}>
              {t('editDialog.cancel')}
            </Button>
            <DisabledReason reason={!canServersManage ? t('editDialog.noPermission') : null}>
              <Button onClick={handleSaveEdit} disabled={savingEdit || !canServersManage}>
                <Check className="w-4 h-4 me-2" /> {savingEdit ? t('editDialog.saving') : t('editDialog.saveChanges')}
              </Button>
            </DisabledReason>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteServer} onOpenChange={(open) => { if (!open && !deleting) { setDeleteServer(null); setDeleteFiles(false); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p>{t('deleteDialog.description', { name: deleteServer?.name })}</p>

                {deleteServer?.installPath && (
                  <div className="flex items-start gap-3 p-3 rounded-lg border bg-muted/50">
                    {/* Gated on server.wipe independently of the base Delete
                        button (servers.manage) -- panel-record-only deletion
                        is a legitimately lower bar, so a role missing
                        server.wipe can still delete the record, just not
                        check this box. The granularity goes where the
                        capability boundary is, not where the button is. */}
                    <DisabledReason reason={!canServerWipe ? t('deleteDialog.deleteFilesNoPermission') : null}>
                      <Checkbox
                        id="deleteFiles"
                        checked={deleteFiles}
                        onCheckedChange={(checked) => setDeleteFiles(checked === true)}
                        disabled={deleting || !canServerWipe}
                        className="mt-1"
                      />
                    </DisabledReason>
                    <label htmlFor="deleteFiles" className="text-sm cursor-pointer">
                      <span className="font-medium text-destructive">{t('deleteDialog.alsoDeleteFilesLabel')}</span>
                      <p className="text-muted-foreground mt-1">
                        {t('deleteDialog.alsoDeleteFilesDesc')}<br />
                        <code className="text-xs bg-background px-1 rounded">{deleteServer?.installPath}</code>
                      </p>
                    </label>
                  </div>
                )}

                {/* Most installs keep the Zomboid data folder (world save)
                    separate from the install folder above, so checking the
                    box only means "reinstall via the Setup Wizard later" --
                    annoying, not catastrophic. When the data path is nested
                    inside the install path instead, this same delete also
                    destroys the world save with no separate copy, and the
                    panel will refuse to run it (see server.js's
                    DELETE_FILES_DATA_PATH_NESTED check) until the data path
                    is moved or backed up by hand. Surfaced here so that
                    refusal isn't the first the operator hears of it. */}
                {deleteFiles && isZomboidDataNestedInInstall(deleteServer?.zomboidDataPath, deleteServer?.installPath) && (
                  <div className="rounded-lg border border-destructive/25 bg-destructive/8 p-3 text-sm">
                    <p className="font-medium text-destructive">{t('deleteDialog.dataPathNestedWarningTitle')}</p>
                    <p className="text-muted-foreground">
                      {t('deleteDialog.dataPathNestedWarningDesc')}
                    </p>
                    <code className="text-xs bg-background px-1 rounded">{deleteServer?.zomboidDataPath}</code>
                  </div>
                )}

                {!deleteFiles && !deleting && (
                  <p className="text-sm text-muted-foreground">
                    {t('deleteDialog.filesNotDeleted')}
                  </p>
                )}

                {deleting && (
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>{deleteFiles ? t('deleteDialog.deletingFiles') : t('deleteDialog.removingServer')}</span>
                    </div>
                    <Progress value={deleteProgress} className="h-1.5" />
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('deleteDialog.cancel')}</AlertDialogCancel>
            <DisabledReason reason={!canServersManage ? t('deleteDialog.noPermission') : null}>
              <Button
                onClick={handleDeleteServer}
                disabled={deleting || !canServersManage}
                className={deleteFiles ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
              >
                {deleting ? (
                  <><Loader2 className="w-4 h-4 animate-spin me-2" />{t('deleteDialog.removing')}</>
                ) : deleteFiles ? t('deleteDialog.deleteEverything') : t('deleteDialog.removeFromPanel')}
              </Button>
            </DisabledReason>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Steam Update/Verify Dialog */}
      <Dialog open={!!steamOperation} onOpenChange={(open) => !open && (!steamRunning || steamStalled) && setSteamOperation(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {steamOperation?.type === 'verify' ? (
                <><ShieldCheck className="w-5 h-5" /> {t('steamDialog.verifyTitle')}</>
              ) : (
                <><RefreshCw className="w-5 h-5" /> {t('steamDialog.updateTitle')}</>
              )}
            </DialogTitle>
            <DialogDescription>
              {steamOperation?.type === 'verify'
                ? t('steamDialog.verifyDesc')
                : t('steamDialog.updateDesc')
              }
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t('steamDialog.steamcmdPathLabel')}</Label>
              <Input
                value={steamcmdPath}
                onChange={e => setSteamcmdPath(e.target.value)}
                placeholder={t('steamDialog.steamcmdPathPlaceholder')}
                className="font-mono text-sm"
                disabled={steamRunning}
              />
              <p className="text-xs text-muted-foreground">
                {t('steamDialog.steamcmdPathHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t('steamDialog.installPathLabel')}</Label>
              <Input
                value={getInstallFolder(steamOperation?.server.installPath)}
                disabled
                className="font-mono text-sm bg-muted"
              />
              <DisabledReason reason={!canServerWipe ? t('clearInstallDialog.noPermission') : null}>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={steamRunning || clearingInstall || !canServerWipe}
                  onClick={() => {
                    if (!canServerWipe) return
                    setConfirmClearInstall(true)
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5 me-2" /> {t('steamDialog.clearFolderButton')}
                </Button>
              </DisabledReason>
              <p className="text-xs text-muted-foreground">
                {t('steamDialog.clearFolderHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t('steamDialog.branchLabel')} {loadingBranches && <Loader2 className="inline-block w-3 h-3 ms-1 animate-spin" />}</Label>
              <Select
                value={steamOperation?.branch || 'public'}
                onValueChange={(value) => steamOperation && setSteamOperation({ ...steamOperation, branch: value })}
                disabled={steamRunning || loadingBranches}
              >
                <SelectTrigger className="w-full text-foreground">
                  {(() => {
                    const current = availableBranches.find(b => b.name === steamOperation?.branch)
                    if (loadingBranches) return <span className="text-muted-foreground">{t('steamDialog.loadingBranches')}</span>
                    if (!current) return <span className="text-muted-foreground">{t('steamDialog.selectBranch')}</span>
                    return (
                      <span className="flex items-center gap-2">
                        <span className="capitalize">{current.name === 'public' ? t('steamDialog.publicStable') : current.name}</span>
                        {(() => {
                          const sb = (steamOperation?.server.branch || '').trim().toLowerCase()
                          const ib = (updateInfo?.installed?.branch || '').trim().toLowerCase()
                          const isCurrent = current.name === ib || current.name === sb
                          return isCurrent ? (
                            <span className="rounded border border-border/60 px-1 py-px font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{t('steamDialog.currentBadge')}</span>
                          ) : null
                        })()}
                      </span>
                    )
                  })()}
                </SelectTrigger>
                <SelectContent>
                  {availableBranches.map((b) => (
                    <SelectItem key={b.name} value={b.name}>
                      <div className="flex flex-col">
                        <span className="capitalize">{b.name === 'public' ? t('steamDialog.publicStable') : b.name}</span>
                        {b.description && <span className="text-xs text-muted-foreground">{t(`steamDialog.branchDescriptions.${b.name}`, { defaultValue: b.description })}</span>}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {(() => {
                  const selected = availableBranches.find(b => b.name === steamOperation?.branch)
                  if (!selected) return t('steamDialog.branchHintDefault')
                  const details = [t(`steamDialog.branchDescriptions.${selected.name}`, { defaultValue: selected.description })]
                  if (selected.buildId) details.push(t('steamDialog.buildPrefix', { buildId: selected.buildId }))
                  if (selected.timeUpdated) details.push(t('steamDialog.updatedPrefix', { date: new Date(selected.timeUpdated).toLocaleString(i18n.language) }))
                  return details.join(' - ')
                })()}
              </p>
            </div>

            {steamLogs.length > 0 && (
              <div className="space-y-2">
                <Label>{t('steamDialog.progressLabel')}</Label>
                <div className="h-48 overflow-y-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs text-foreground">
                  {steamLogs.map((log, i) => (
                    <div key={i}>{log}</div>
                  ))}
                </div>
              </div>
            )}

            {steamStalled && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
                {t('steamDialog.stalledMessage')}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSteamOperation(null)}
              disabled={steamRunning && !steamStalled}
            >
              {steamStalled ? t('steamDialog.closeAnyway') : steamRunning ? t('steamDialog.running') : steamCompleted ? t('steamDialog.close') : t('steamDialog.cancel')}
            </Button>
            {!steamCompleted && (
              <DisabledReason reason={!canServerInstall ? t('steamDialog.noPermission') : null}>
                <Button
                  onClick={handleStartSteamOperation}
                  disabled={steamRunning || !steamcmdPath.trim() || !canServerInstall}
                >
                  {steamRunning ? (
                    <><Loader2 className="w-4 h-4 me-2 animate-spin" /> {t('steamDialog.running')}</>
                  ) : steamOperation?.type === 'verify' ? (
                    <><ShieldCheck className="w-4 h-4 me-2" /> {t('steamDialog.startVerify')}</>
                  ) : (
                    <><RefreshCw className="w-4 h-4 me-2" /> {t('steamDialog.startUpdate')}</>
                  )}
                </Button>
              </DisabledReason>
            )}
            {steamCompleted === 'success' && (
              <Button
                variant="default"
                onClick={() => setSteamOperation(null)}
              >
                <CheckCircle2 className="w-4 h-4 me-2" /> {t('steamDialog.done')}
              </Button>
            )}
            {steamCompleted === 'error' && (
              <DisabledReason reason={!canServerInstall ? t('steamDialog.noPermission') : null}>
                <Button
                  onClick={() => { setSteamCompleted(null); handleStartSteamOperation(); }}
                  disabled={!steamcmdPath.trim() || !canServerInstall}
                >
                  <RefreshCw className="w-4 h-4 me-2" /> {t('steamDialog.retry')}
                </Button>
              </DisabledReason>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear Installation Folder confirmation */}
      <AlertDialog open={confirmClearInstall} onOpenChange={(open) => !open && !clearingInstall && setConfirmClearInstall(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('clearInstallDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('clearInstallDialog.descriptionBefore')}{' '}
              <code className="text-xs bg-background px-1 rounded">
                {getInstallFolder(steamOperation?.server.installPath)}
              </code>
              {' '}{t('clearInstallDialog.descriptionAfter')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearingInstall}>{t('clearInstallDialog.cancel')}</AlertDialogCancel>
            <DisabledReason reason={!canServerWipe ? t('clearInstallDialog.noPermission') : null}>
              <Button
                onClick={handleClearInstallFolder}
                disabled={clearingInstall || !canServerWipe}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {clearingInstall ? (
                  <><Loader2 className="w-4 h-4 animate-spin me-2" />{t('clearInstallDialog.clearing')}</>
                ) : (
                  <><Trash2 className="w-4 h-4 me-2" />{t('clearInstallDialog.clearFolder')}</>
                )}
              </Button>
            </DisabledReason>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Discovery Setup — "Connect" from the mount discovery banner */}
      <DiscoverySetup
        open={!!discoverySetupMount}
        onOpenChange={(open) => !open && setDiscoverySetupMount(null)}
        mount={discoverySetupMount}
        onCreated={() => { fetchServers(); fetchServerStatuses() }}
      />
    </div>
  )
}
