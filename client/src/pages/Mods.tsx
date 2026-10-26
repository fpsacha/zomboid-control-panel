import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useSocket } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useAuth } from '@/contexts/AuthContext'
import { DisabledReason } from '@/components/DisabledReason'
import { copyText, cn } from '@/lib/utils'
import {
  Package,
  RefreshCw,
  Plus,
  Trash2,
  ExternalLink,
  AlertTriangle,
  CheckCircle,
  Clock,
  Download,
  FileText,
  Map as MapIcon,
  Library,
  Search,
  Filter,
  Settings2,
  ChevronRight,
  Check,
  Info,
  Layers,
  Save,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Wrench,
  PlusCircle,
  X,
  EyeOff,
  Wand2,
  ShieldAlert,
  Power,
  ListOrdered,
  Bookmark,
  StickyNote,
  FolderPlus,
  FolderMinus,
  History,
  HardDrive,
  HeartPulse,
} from 'lucide-react'
import { ConflictScanResult, ScanStreamModScanned, ScanStreamConflictFound } from '@/types'
import { WorkshopCollectionPanel } from '@/components/WorkshopCollectionPanel'
import { ConflictsPanel, type ConflictsFocus } from '@/components/mods/ConflictsPanel'
import { ModRow, WorkshopIdChip, WorkshopLinkAction, WorkshopThumb } from '@/components/mods/ModRow'
import { BridgeManagedBadge } from '@/components/mods/BridgeManagedBadge'
import { ModGroupsPanel, type CreateGroupRequest } from '@/components/mods/ModGroupsPanel'
import { ModGroupDialog, type ModGroupDialogValues } from '@/components/mods/ModGroupDialog'
import { AddToGroupDialog } from '@/components/mods/AddToGroupDialog'
import { ModNoteDialog } from '@/components/mods/ModNoteDialog'
import { GroupDot, GroupDots, NoteIndicator } from '@/components/mods/GroupDots'
import { GroupSections } from '@/components/mods/GroupSections'
import { GroupSuggestions } from '@/components/mods/GroupSuggestions'
import { useGroupSuggestions } from '@/components/mods/useGroupSuggestions'
import { LoadOrderList } from '@/components/mods/LoadOrderList'
import { SmartSortPreview } from '@/components/mods/SmartSortPreview'
import { WhyHerePopover } from '@/components/mods/WhyHerePopover'
import { KindChip } from '@/components/mods/KindChip'
import { ItemInsights } from '@/components/mods/ItemInsights'
import { HealthView } from '@/components/mods/HealthView'
import { HealthSummaryCard } from '@/components/mods/HealthSummaryCard'
import { DuplicateItemsNotice } from '@/components/mods/DuplicateItemsNotice'
import { duplicateItemSets, keepFixesFor, type DuplicateItemSet } from '@/components/mods/duplicateItems'
import { useHealthText } from '@/components/mods/healthText'
import { PinnedOrderCard } from '@/components/mods/PinnedOrderCard'
import { OrderRuleDialog } from '@/components/mods/OrderRuleDialog'
import { useSmartMods } from '@/components/mods/useSmartMods'
import { SHOWN_KINDS } from '@/components/mods/smartText'
import { VirtualRows } from '@/components/mods/VirtualRows'
import { useModGroupsStore } from '@/components/mods/useModGroupsStore'
import { useModNotes } from '@/components/mods/useModNotes'
import { addModsToGroup, removalLeavesTooFew, removeModsFromGroup, saveGroupValues } from '@/components/mods/groupActions'
import { useApplyGroupOrder } from '@/components/mods/useApplyGroupOrder'
import { useGroupOrderNotice } from '@/components/mods/useGroupOrderNotice'
import { isBridgeManagedMod } from '@/lib/bridgeDeliveryView'
import type { BridgeManaged } from '@/lib/bridgeDeliveryTypes'
import {
  useLocalStorageState,
  type TrackedMod,
  type ModStatus,
  type ModEntry,
  type WsGroup,
  type DepSearchHit,
  type DepSearchState,
} from '@/lib/modsShared'
import { getAccessToken } from '@/lib/authToken'
import { isDemoMode } from '@/lib/demo'
import { createConflictScanSnapshot, recalculateConflictWinners } from '@/lib/conflictSeverity'
import { computeVariantSiblings } from '@/lib/modVariants'
import { FixEverythingButton } from '@/components/mods/FixEverythingButton'
import { useFixEverything } from '@/components/mods/useFixEverything'
import { PageHeader } from '@/components/PageHeader'
import { PageAlerts, type PageAlert } from '@/components/PageAlerts'
import { SaveBar } from '@/components/SaveBar'
import { SubNav, SubNavLayout, type SubNavGroup } from '@/components/ui/sub-nav'
import { Toolbar } from '@/components/ui/toolbar'
import { Segmented } from '@/components/ui/segmented'
import { RowActions, type RowActionItem } from '@/components/ui/row-actions'
import { SectionCard } from '@/components/ui/section-card'
import { StatusPill } from '@/components/ui/status-pill'
import { Skeleton } from '@/components/ui/skeleton'
import { useUrlParamState } from '@/hooks/useUrlParamState'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NumberInput } from '@/components/NumberInput'
import { Label } from '@/components/ui/label'
import { HelpTip } from '@/components/HelpTip'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { reportClientError, reportClientWarning } from '@/lib/client-errors'
import { getUserErrorMessage, getResultErrorMessage } from '@/lib/errorMessage'
import { useDateFormat } from '@/lib/dateFormat'
import { resolveRegisteredTranslation } from '@/lib/paramTranslation'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { modsApi, serversApi, ApiError, type ModGroup, type ModHealthFix, type ModHealthIssue, type ModKind } from '@/lib/api'
import { launchIsOperatorDefined } from '@/lib/launchTarget'
import { FolderBrowser } from '@/components/FolderBrowser'
import {
  buildRequiresMap,
  createRequirementResolver,
  reconcileLoadOrder,
  sameLoadOrderEntries,
} from '@/lib/modLoadOrder'
import { groupsOfMods, summarizeGroupConflicts, type GroupConflictSummary } from '@/lib/modGroupTools'
import {
  ACTIVE_SORTS,
  ALL_GROUPS,
  INSTALLED_SORTS,
  filterActiveItems,
  filterInstalledMods,
  modsOnServer,
  matchesActiveSearch,
  parseGroupFilter,
  sortActiveItems,
  sortInstalledMods,
  type ActiveSort,
  type GroupFilter,
  type InstalledSort,
} from '@/lib/modListFilters'
import { EmptyState } from '@/components/EmptyState'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface CollectionMod {
  workshopId: string
  name: string
  description?: string
  tags?: string[]
  isMap: boolean
  modId?: string
  mapFolder?: string
  selected?: boolean
}

interface IniConfig {
  configured: boolean
  modIds: string[]
  workshopIds: string[]
  maps: string[]
  totalMods: number
  iniPath?: string
  error?: string
  code?: string
  workshopModMap?: Record<string, Array<{ id: string; name: string; enabled: boolean; require?: string[] }>>
  duplicateKeys?: Array<{ key: string; count: number }>
  // Set while the active server gets PanelBridge from the Steam Workshop
  // (GET /mods/current-config, spec §4.11): that item's enable and remove
  // controls are locked in "Active on server". The server's ini guard
  // (routes/mods.js) is the real enforcement and puts the entries back.
  bridgeManaged?: BridgeManaged | null
}

// Why GET /mods/current-config found no config folder when it was refused
// rather than unset (server/routes/mods.js's withConfigRefusal()).
const FOLDER_REFUSAL_CODES = new Set(['ZOMBOID_DATA_FOLDER_REFUSED', 'SERVER_CONFIG_PATH_OUTSIDE_DATA'])

// ── Pure helper — parse workshop ID from URL or numeric input ──
function parseWorkshopId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const urlMatch = trimmed.match(/[?&]id=(\d+)/)
  if (urlMatch) return urlMatch[1]
  const numericMatch = trimmed.match(/^(\d{6,15})$/)
  if (numericMatch) return numericMatch[1]
  return null
}

/**
 * One flat set of destinations, kept in the URL (`/mods?view=`): the Library
 * (what the panel tracks), what is on the server (and in which order), and
 * the tools. The old "Add mods" view is gone: its queue was never filled, and
 * Sync Mod IDs lives in Tools.
 */
const MODS_VIEWS = ['installed', 'deactivated', 'active', 'order', 'conflicts', 'health', 'collection', 'presets', 'tools'] as const
type ModsView = (typeof MODS_VIEWS)[number]

const CONFIG_VIEWS: readonly ModsView[] = ['active', 'order', 'health', 'presets', 'tools']

const VIEW_ICONS: Record<ModsView, typeof Package> = {
  installed: Package,
  deactivated: EyeOff,
  active: Power,
  order: ListOrdered,
  conflicts: ShieldAlert,
  health: HeartPulse,
  collection: Library,
  presets: Bookmark,
  tools: Wrench,
}

const NAV_GROUPS: Array<{ id: string; labelKey: string; views: ModsView[] }> = [
  { id: 'library', labelKey: 'nav.groupLibrary', views: ['installed', 'deactivated'] },
  { id: 'server', labelKey: 'nav.groupServer', views: ['active', 'order', 'conflicts', 'health'] },
  { id: 'tools', labelKey: 'nav.groupTools', views: ['collection', 'presets', 'tools'] },
]

// "What changed" for a Workshop item with an update: its Steam change notes.
const changelogUrl = (workshopId: string) => `https://steamcommunity.com/sharedfiles/filedetails/changelog/${workshopId}`

type ListMode = 'list' | 'groups'

interface ActiveExtraFilters {
  updates: boolean
  missingDep: boolean
  hasNote: boolean
  group: GroupFilter
}

interface InstalledExtraFilters {
  hasNote: boolean
  group: GroupFilter
}

// Stores the exact lastSteamApiFailureAt value that was dismissed, not a
// boolean. That field is re-stamped to now() on EVERY consecutive failed
// check cycle (not just the first one of an outage -- see modChecker.js),
// so this isn't a stable "outage started at" episode key the way Discord's
// gatewayDegradedSince is; it's "most recent failure seen". A dismiss here
// re-surfaces the indicator once the NEXT failed cycle re-stamps the value
// -- a gentle periodic reminder for a still-unresolved outage, not a
// permanent one-time silence, which is the right tradeoff given the field
// actually available (no server-side episode id to build a tighter key on).
const STEAM_API_ISSUE_DISMISSED_KEY = 'pz-mods-steam-api-issue-dismissed'

// pz-bughunt round 17 (every write that trusts the server-side active
// server): new copy below ships via this fallback rather than new locale
// JSON keys, same call as Dashboard.tsx's own dashboardFallback -- a key
// registered in NO locale always resolves to English for everyone, so
// localeParity.test.ts's 9-locale key-SET parity has nothing to be out of
// parity about.
function modsFallback(key: string, fallback: string): string {
  return resolveRegisteredTranslation('mods', key, undefined) ?? fallback
}

export default function Mods() {
  const { t, i18n } = useTranslation('mods')
  const { t: tGroups } = useTranslation('modGroups')
  const { t: tSmart } = useTranslation('modsSmart')
  const { formatDate } = useDateFormat()
  const [searchParams] = useSearchParams()
  const reviewUnresolved = searchParams.get('review') === 'unresolved'
  const reviewDeepLinkStarted = useRef(false)
  const demoMode = isDemoMode()
  // The section in the URL (?view=), so a reload or a link opens it. The
  // dashboard's "review unresolved dependencies" link lands on Conflicts.
  const [activeTab, setActiveTab] = useUrlParamState<ModsView>('view', MODS_VIEWS, reviewUnresolved ? 'conflicts' : 'installed')
  const [mods, setMods] = useState<TrackedMod[]>([])
  // Until the first load lands, the lists show a skeleton instead of an empty state.
  const [initialLoading, setInitialLoading] = useState(true)
  const [status, setStatus] = useState<ModStatus | null>(null)
  const [steamApiIssueDismissed, setSteamApiIssueDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STEAM_API_ISSUE_DISMISSED_KEY)
    } catch {
      return null
    }
  })
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [workshopBrowserOpen, setWorkshopBrowserOpen] = useState(false)
  const [workshopBrowserInitialPath, setWorkshopBrowserInitialPath] = useState<string | undefined>()
  const [savingWorkshopPath, setSavingWorkshopPath] = useState(false)
  const { toast } = useToast()
  const confirm = useConfirm()
  const noticeGroupOrder = useGroupOrderNotice()
  const { can } = useAuth()
  // mods.js gates every route (including reads) behind mods.manage via a
  // whole-file router.use, except GET /thumbnail/:workshopId -- every
  // mutating action below needs mods.manage. The one outlier is the
  // Workshop install-path save, which goes through serversApi.update (PUT
  // /servers/:id, servers.manage) instead -- a different route file
  // entirely, not mods.js. OPEN when capabilities are unknown/null, same
  // convention as every other capability check in the app.
  const canManageMods = can('mods.manage')
  const canManageServers = can('servers.manage')
  // Saving that path on a server with its own start command or launcher
  // script also takes files.manage (RCE-STARTCMD, lib/launchTarget.ts).
  const canFilesManage = can('files.manage')

  // Search and filters (Installed). The chips are remembered per browser.
  const [searchQuery, setSearchQuery] = useState('')
  const [deferredSearchQuery, setDeferredSearchQuery] = useState('')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trackedModsRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showUpdatesOnly, setShowUpdatesOnly] = useLocalStorageState<boolean>('zcp:mods:installed:updatesOnly', false)
  const [installedFilters, setInstalledFilters] = useLocalStorageState<InstalledExtraFilters>('zcp:mods:installed:filters', { hasNote: false, group: ALL_GROUPS })
  const [installedSort, setInstalledSort] = useLocalStorageState<InstalledSort>('zcp:mods:installed:sort', 'status')
  const [installedMode, setInstalledMode] = useLocalStorageState<ListMode>('zcp:mods:installed:mode', 'list')
  const [selectedMods, setSelectedMods] = useState<Set<string>>(new Set())

  // Mods downloaded into the Steam workshop folder but not in the server
  // INI's WorkshopItems= list: a section of the Deactivated view, scanned
  // when that view opens.
  const [disabledMods, setDisabledMods] = useState<Array<{ workshop_id: string; name: string }>>([])
  const [disabledLoading, setDisabledLoading] = useState(false)
  const [disabledScanned, setDisabledScanned] = useState(false)
  const [enablingId, setEnablingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Which group dialog / picker / note editor is open, from any view.
  const [groupEditor, setGroupEditor] = useState<{ group: ModGroup | null; initialModIds?: readonly string[]; initialName?: string; fromSuggestion?: boolean } | null>(null)
  const [addToGroup, setAddToGroup] = useState<{ modIds: string[]; label?: string; clearSelection?: 'installed' | 'order' } | null>(null)
  const [noteEditor, setNoteEditor] = useState<{ workshopId: string; name: string } | null>(null)
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null)
  // The Conflicts view filtered to one group's mods (its badge was clicked).
  const [conflictsFocus, setConflictsFocus] = useState<ConflictsFocus | null>(null)

  // Advanced Add Mod dialog (with multi-ID selection)
  const [advancedAddOpen, setAdvancedAddOpen] = useState(false)
  const [advancedModInput, setAdvancedModInput] = useState('')
  const [discoveringMod, setDiscoveringMod] = useState(false)
  const [showAdvancedIdSelection, setShowAdvancedIdSelection] = useState(false)
  const [discoveredMod, setDiscoveredMod] = useState<{
    workshopId: string
    name: string
    description: string | null
    modIds: string[]
    hasMultipleModIds: boolean
    isMap: boolean
    mapFolders: string[]
    isDownloaded: boolean
    tags: string[]
    alreadyConfigured?: string[]
    isAlreadyAdded?: boolean
  } | null>(null)
  const [selectedModIds, setSelectedModIds] = useState<Set<string>>(new Set())

  // Collection import
  const [collectionUrl, setCollectionUrl] = useState('')
  const [collectionDialogOpen, setCollectionDialogOpen] = useState(false)
  const [collectionMods, setCollectionMods] = useState<CollectionMod[]>([])
  const [importingCollection, setImportingCollection] = useState(false)
  const [collectionImported, setCollectionImported] = useState(false)
  const [showCollectionAdvanced, setShowCollectionAdvanced] = useState(false)

  // INI configuration
  const [iniConfig, setIniConfig] = useState<IniConfig | null>(null)
  // Mod groups and notes, shared by every view (dots on rows, Groups view,
  // Load order blocks, Auto-sort). The groups' in-order status is read again
  // whenever the saved Mods= order changes (a save, an Apply, a toggle).
  const groupsStore = useModGroupsStore({ savedModIds: iniConfig?.modIds })
  const notesStore = useModNotes()
  const [orderedModIds, setOrderedModIds] = useState<string[]>([])
  // The Load order list and the saved Mods= it started from, as of the last
  // render, for reloads that land later: unsaved moves must survive them.
  const orderedModIdsRef = useRef<string[]>([])
  const savedModIdsRef = useRef<string[]>([])
  useEffect(() => {
    orderedModIdsRef.current = orderedModIds
    savedModIdsRef.current = iniConfig?.modIds ?? []
  }, [orderedModIds, iniConfig?.modIds])
  // The server's Mods= arrived (a reload, a write elsewhere on the page):
  // unsaved moves are kept with the server's additions and removals merged
  // in, unless `adopt` (the page itself just wrote this order).
  const syncOrderFromServer = useCallback((nextSaved: string[], adopt = false) => {
    const next = adopt ? [...nextSaved] : reconcileLoadOrder(orderedModIdsRef.current, savedModIdsRef.current, nextSaved)
    orderedModIdsRef.current = next
    savedModIdsRef.current = nextSaved
    setOrderedModIds(next)
  }, [])
  // Mods ticked on the Load order tab, for "Create group from selection".
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(() => new Set())
  const [createGroupRequest, setCreateGroupRequest] = useState<CreateGroupRequest | null>(null)
  useEffect(() => {
    setSelectedOrderIds((prev) => {
      if (prev.size === 0) return prev
      const present = new Set(orderedModIds)
      const next = new Set([...prev].filter((id) => present.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [orderedModIds])
  const [selectedActiveWsId, setSelectedActiveWsId] = useState<string | null>(null)
  const [savingModOrder, setSavingModOrder] = useState(false)
  // bug-hunt-2026-09-04/05: modsApi.saveModOrder(orderedModIds) takes no
  // server id -- it resolves the active server fresh server-side per
  // request, same pattern as ServerConfig's ini/sandbox routes. This page
  // never listened for activeServerChanged at all (mount-only, see
  // initializeData below), so the concrete scenario the overnight sweep
  // confirmed was real: reorder mods on server A, switch to server B
  // elsewhere, hit "Save Order" -- server A's list gets written into
  // server B's real INI. Scoped to the confirmed Save Load Order path for
  // now; other actions sharing the same no-server-id shape were a flagged
  // follow-up, picked up by pz-bughunt round 17 below (see
  // pendingAddServerChanged) -- one of the originally-named examples,
  // writeToIni and its "Add mods" queue, was unreachable (the queue was never
  // filled) and has since been removed. batchRemove/deleteDiskMod/toggleModId/etc. are a
  // narrower, race-window-only class (a rendered list row stays clickable
  // for the few hundred ms before a plain refetch lands) rather than an
  // open-ended dirty-edit window like this one; reported to god, not fixed
  // this round.
  const [serverChangedSinceLoad, setServerChangedSinceLoad] = useState(false)
  // pz-bughunt round 17: modsApi.addModAdvanced (Add-mod-by-workshop-ID
  // dialog) and modsApi.addModAdvanced-via-handleAddCollectionMods (Import
  // Collection dialog) share the identical no-server-id shape as
  // saveModOrder above, AND their payload is tied to a specific server the
  // same way: discoverWorkshopMod()/handleImportCollection() call
  // modsApi.discoverModIds/collectionDiff, which resolve mod-id/map-folder
  // auto-detection from the ACTIVE server's own on-disk workshop mount at
  // discovery time (see routes/mods.js's findModIdFromWorkshop). If the
  // active server changes while either dialog is still open (discoveredMod
  // or a pending collectionMods review), the ids/map-folders shown were
  // resolved against the OLD server's mount and may not even apply to the
  // NEW one -- clicking Add would write them into the new server's real ini
  // regardless. One shared flag for both dialogs since they're the same
  // hazard shape reached through two entry points, exactly like
  // serverChangedSinceLoad above already covers two entry points
  // (handleSaveModOrder, promoteModOverOpponent) for the reorder hazard.
  const [pendingAddServerChanged, setPendingAddServerChanged] = useState(false)
  // "Show groups" on the Load order list: each group as a block with a header.
  const [showGroupBlocks, setShowGroupBlocks] = useLocalStorageState<boolean>('zcp:mods:order:showGroups', false)
  // Expand/collapse states
  const [repairingMaps, setRepairingMaps] = useState(false)
  const [mapRepairResult, setMapRepairResult] = useState<{ removed: string[]; added?: string[]; remaining: string[]; message: string } | null>(null)
  // workshopId + a display label to confirm single remove. The dialog used to
  // say only "Remove this mod from the server?" with no way to tell which of
  // several selected/hovered mods it meant -- naming the target here so the
  // confirm dialog can show it instead of a generic "this mod".
  const [confirmRemoveMod, setConfirmRemoveMod] = useState<{ wsId: string; label: string } | null>(null)
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false)
  const [ignoredMods, setIgnoredMods] = useState<Array<{ workshop_id: string; name: string | null; ignored_at: string }>>([])
  // Rows ticked in the ignored list, for "Remove selected" (issue #232).
  const [selectedIgnored, setSelectedIgnored] = useState<Set<string>>(() => new Set())
  // Conflict pairs the user has explicitly dismissed as false positives.
  const [ignoredPairs, setIgnoredPairs] = useState<Array<{ mod_a: string; mod_b: string; reason?: string | null }>>([])
  const [confirmRemoveWorkshop, setConfirmRemoveWorkshop] = useState<{ wsId: string; knownModIds: string[] } | null>(null) // wsId for config tab remove
  const [deduplicating, setDeduplicating] = useState(false)
  const [deduplicateResult, setDeduplicateResult] = useState<string | null>(null)
  const [filterMultiId, setFilterMultiId] = useLocalStorageState<boolean>('zcp:mods:active:multiIdOnly', true)
  // "Active on server" list shape. Compact hides the per-ID chip grid (still
  // reachable in the inspector); warnings render in both densities.
  const [filterAttention, setFilterAttention] = useLocalStorageState<boolean>('zcp:mods:active:attentionOnly', false)
  // Only the workshop items that have a mod ID which is not in Mods= (the "170 of 186 IDs enabled" gap).
  const [filterNotEnabled, setFilterNotEnabled] = useLocalStorageState<boolean>('zcp:mods:active:notEnabledOnly', false)
  const [activeFilters, setActiveFilters] = useLocalStorageState<ActiveExtraFilters>('zcp:mods:active:filters', { updates: false, missingDep: false, hasNote: false, group: ALL_GROUPS })
  const [activeSort, setActiveSort] = useLocalStorageState<ActiveSort>('zcp:mods:active:sort', 'config')
  const [activeMode, setActiveMode] = useLocalStorageState<ListMode>('zcp:mods:active:mode', 'list')
  // "Kind" filter on Active on server (smart sort's classification); 'all' is off.
  const [activeKindRaw, setActiveKind] = useLocalStorageState<string>('zcp:mods:active:kind', 'all')
  const activeKind: ModKind | null = SHOWN_KINDS.includes(activeKindRaw as ModKind) ? (activeKindRaw as ModKind) : null
  // "Select" on Active on server: a tick per row for "Add selected to group"
  // (the row's own checkbox is the enable switch, so ticks only show in this mode).
  const [activeSelecting, setActiveSelecting] = useState(false)
  const [selectedActiveWs, setSelectedActiveWs] = useState<Set<string>>(() => new Set())
  const [activeDensity, setActiveDensity] = useLocalStorageState<'compact' | 'detailed'>('zcp:mods:active:density', 'compact')
  const [modManagerSearch, setModManagerSearch] = useState('')
  const [deferredModManagerSearch, setDeferredModManagerSearch] = useState('')
  const modSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [lastSavedMod, setLastSavedMod] = useState<string | null>(null)
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busyRef = useRef(false) // Synchronous guard against double-submission
  const discoverAbortRef = useRef<AbortController | null>(null)

  // Restart settings dialog
  const [restartSettingsOpen, setRestartSettingsOpen] = useState(false)
  const [restartWarningMinutes, setRestartWarningMinutes] = useState(5)
  const [delayIfPlayersOnline, setDelayIfPlayersOnline] = useState(false)
  const [maxDelayMinutes, setMaxDelayMinutes] = useState(30)

  // Conflict scanner
  const [conflicts, setConflicts] = useState<ConflictScanResult | null>(null)
  const [conflictsLoading, setConflictsLoading] = useState(false)
  const [conflictsError, setConflictsError] = useState<string | null>(null)
  const [lastScanTime, setLastScanTime] = useState<Date | null>(null)
  const [scanIniSnapshot, setScanIniSnapshot] = useState<string | null>(null)
  // SSE streaming scan state
  const [scanProgress, setScanProgress] = useState(0)
  const [scanCurrentMod, setScanCurrentMod] = useState<string | null>(null)
  const [scanModsScanned, setScanModsScanned] = useState(0)
  const [scanTotalMods, setScanTotalMods] = useState(0)
  const [streamConflicts, setStreamConflicts] = useState<ScanStreamConflictFound[]>([])
  const eventSourceRef = useRef<EventSource | null>(null)
  const closingIntentionallyRef = useRef(false)
  const sseIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Batched scan-progress ref — flush via rAF to coalesce rapid SSE updates into 1 render
  const scanBatchRef = useRef<{ progress: number; modName: string | null; modsScanned: number; dirty: boolean; raf: number }>({ progress: 0, modName: null, modsScanned: 0, dirty: false, raf: 0 })

  // Missing deps state
  const [depAdding, setDepAdding] = useState<string[]>([])
  const [depAddResults, setDepAddResults] = useState<Record<string, 'added' | 'error'>>({})
  // Inline Workshop search per unresolved dep row (key → state)
  const [depSearchOpen, setDepSearchOpen] = useState<Set<string>>(new Set())
  const [depSearchData, setDepSearchData] = useState<Record<string, DepSearchState>>({})

  // Workshop collection sync status — lightweight read of the diff endpoint.
  // Only fetched when a collection ID is configured server-side.
  const [collectionStatus, setCollectionStatus] = useState<{
    configured: boolean
    autoSync: boolean
    inSync: boolean
    drift: number
    title: string | null
    error: string | null
    loading: boolean
  }>({ configured: false, autoSync: false, inSync: false, drift: 0, title: null, error: null, loading: false })
  const [collectionSyncing, setCollectionSyncing] = useState(false)
  // Clean up SSE connection on unmount or page navigation
  useEffect(() => {
    return () => {
      closingIntentionallyRef.current = true
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      sseIdleTimerRef.current = null
      cancelAnimationFrame(scanBatchRef.current.raf)
    }
  }, [])

  // Detect stale conflict results when INI config changes
  const conflictsStale = useMemo(() => {
    if (!conflicts || !scanIniSnapshot) return false
    const currentSnapshot = createConflictScanSnapshot(iniConfig?.workshopIds, iniConfig?.modIds)
    return currentSnapshot !== scanIniSnapshot
  }, [conflicts, scanIniSnapshot, iniConfig?.workshopIds, iniConfig?.modIds])

  // Smart sort v2 (components/mods/useSmartMods): kinds, health, order
  // rules, the plan of the order on screen and the smart sort proposal. A
  // stale scan (or one of another server) gives the planner no winners.
  const smart = useSmartMods({
    canManage: canManageMods,
    configured: iniConfig?.configured === true,
    saved: iniConfig,
    order: orderedModIds,
    planCurrent: activeTab === 'order',
    groups: groupsStore.groups,
    conflicts,
    conflictsStale: conflictsStale || serverChangedSinceLoad,
  })
  const autoSortPreview = smart.smartSort.preview
  const closeSmartSort = smart.smartSort.close
  const smartInsightOf = smart.insights.insightOf

  // Track if auto-discover is pending (moved here for cleanup)
  const autoDiscoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAutoDiscoverIdRef = useRef<string | null>(null)

  // Every way the Add-mod dialog closes (Escape, Cancel, the collection
  // link, a finished add) resets it and stops its lookup: the server stops
  // its SteamCMD download when the request goes away, a reopened dialog
  // takes a new URL, and the old result never lands in it.
  const setAdvancedAddDialogOpen = useCallback((open: boolean) => {
    setAdvancedAddOpen(open)
    if (open) return
    discoverAbortRef.current?.abort()
    discoverAbortRef.current = null
    setDiscoveringMod(false)
    setAdvancedModInput('')
    setDiscoveredMod(null)
    setSelectedModIds(new Set())
    setShowAdvancedIdSelection(false)
    lastAutoDiscoverIdRef.current = null
    if (autoDiscoverTimeoutRef.current) {
      clearTimeout(autoDiscoverTimeoutRef.current)
      autoDiscoverTimeoutRef.current = null
    }
  }, [])

  // Mod Presets
  interface ModPreset {
    id: number
    name: string
    description: string
    workshop_ids: string[]
    mods: string[]
    created_at: string
    updated_at: string
  }
  const [presets, setPresets] = useState<ModPreset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  // mods.js gates its whole router (reads included) behind mods.manage --
  // so a role that lacks it doesn't get a partially-broken page, it gets
  // every one of the five mount-time fetches below rejecting at once and
  // "The backend may be unreachable" being shown, which is FALSE: the
  // backend answered and said no (bug-hunt-2026-08-27, Angela's stock-role
  // hunt). Answer that with one clean page-level state instead, same
  // precedent as Users.tsx/RolesPermissions.tsx/OidcSettings.tsx/
  // Debug.tsx (28bfb0c) -- a real 403 from the mount-time fetch, not a
  // client-side can() guess.
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [savePresetOpen, setSavePresetOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetDescription, setPresetDescription] = useState('')
  const [savingPreset, setSavingPreset] = useState(false)
  const [applyingPreset, setApplyingPreset] = useState<number | null>(null)
  const [confirmApplyPreset, setConfirmApplyPreset] = useState<{ id: number; name: string; modCount: number } | null>(null)
  const [confirmDeletePreset, setConfirmDeletePreset] = useState<{ id: number; name: string } | null>(null)

  // Mod conflict detection
  interface ModConflict {
    type: 'duplicate' | 'missing_modid' | 'outdated_dependency'
    severity: 'warning' | 'info'
    message: string
    modIds?: string[]
  }

  // Detect conflicts in current configuration
  const detectedConflicts = useMemo((): ModConflict[] => {
    if (!iniConfig?.configured) return []
    const conflicts: ModConflict[] = []

    // Check for duplicate mod IDs
    const modIdCounts: Record<string, number> = {}
    for (const modId of iniConfig.modIds) {
      modIdCounts[modId] = (modIdCounts[modId] || 0) + 1
    }
    const duplicates = Object.entries(modIdCounts).filter(([, count]) => count > 1)
    if (duplicates.length > 0) {
      conflicts.push({
        type: 'duplicate',
        severity: 'warning',
        message: t('serverConfigTab.duplicateModIdsFound', { ids: duplicates.map(([id]) => id).join(', ') }),
        modIds: duplicates.map(([id]) => id)
      })
    }

    // Check for workshop items without corresponding mod IDs
    // This is normal for mods not yet downloaded, so just info level
    const workshopCount = iniConfig.workshopIds?.length || 0
    const modIdCount = iniConfig.modIds?.length || 0
    if (workshopCount > 0 && modIdCount === 0) {
      conflicts.push({
        type: 'missing_modid',
        severity: 'info',
        message: t('serverConfigTab.workshopItemsNoModIds', { count: workshopCount }),
      })
    }

    return conflicts
  }, [iniConfig, t])

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (autoDiscoverTimeoutRef.current) {
        clearTimeout(autoDiscoverTimeoutRef.current)
      }
      if (savedTimeoutRef.current) {
        clearTimeout(savedTimeoutRef.current)
      }
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
      }
      if (trackedModsRetryRef.current) {
        clearTimeout(trackedModsRetryRef.current)
      }
      if (modSearchTimerRef.current) {
        clearTimeout(modSearchTimerRef.current)
      }
      discoverAbortRef.current?.abort()
      discoverAbortRef.current = null
      // Cancel any in-flight conflict scan
      eventSourceRef.current?.close()
    }
  }, [])

  // Debounced search handlers (300ms)
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => setDeferredSearchQuery(value), 300)
  }, [])

  const handleModManagerSearchChange = useCallback((value: string) => {
    setModManagerSearch(value)
    if (modSearchTimerRef.current) clearTimeout(modSearchTimerRef.current)
    modSearchTimerRef.current = setTimeout(() => setDeferredModManagerSearch(value), 300)
  }, [])

  // 2026-09-08 (retry-stacking sweep): `manual` distinguishes the Retry
  // button (a human already watching this exact failure) from every other
  // caller of this function -- mount, socket-triggered refreshes, and the
  // ~30 post-action refetches elsewhere in this file all keep the default
  // automatic retry, which is the right tolerance for a transient blip
  // nobody is staring at. Same shape as Servers.tsx's fetchServers(); see
  // its own comment for the full reasoning.
  // `adoptServerOrder`: the page itself just wrote the load order (Save, "Make
  // X win", a preset), so the list takes what the server wrote as it is.
  const fetchData = useCallback(async (opts?: { manual?: boolean; adoptServerOrder?: boolean }) => {
    const retries = opts?.manual ? { retries: 0 } : undefined
    setFetchError(null)
    try {
      // Use allSettled so one failure doesn't break everything
      const results = await Promise.allSettled([
        modsApi.getTrackedMods(retries),
        modsApi.getStatus(retries),
        modsApi.getCurrentConfig(retries),
        modsApi.getIgnoredMods(retries),
        modsApi.getIgnoredModPairs(retries)
      ])

      // mods.js gates every one of these five behind mods.manage as a
      // whole-file router.use -- so a role that lacks it gets ALL FIVE
      // rejecting with a real 403, not a mix of failures. That's the one
      // shape "the backend may be unreachable" is actively wrong for: the
      // backend answered every request and said no. Checked before any
      // per-result processing (including the retry-timer below, which
      // would otherwise keep re-requesting a 403 every 1.5s forever).
      const allRejected403 = results.every(
        (r) => r.status === 'rejected' && r.reason instanceof ApiError && r.reason.status === 403,
      )
      if (allRejected403) {
        setPermissionDenied(true)
        setInitialLoading(false)
        return
      }
      setPermissionDenied(false)

      // Extract successful results
      if (results[0].status === 'fulfilled') {
        setMods(results[0].value.mods || [])
      } else {
        reportClientError('Failed to fetch tracked mods.', results[0].reason)
        setFetchError('Mod list is temporarily unavailable. Retrying...')
        if (trackedModsRetryRef.current) clearTimeout(trackedModsRetryRef.current)
        trackedModsRetryRef.current = setTimeout(async () => {
          try {
            const retry = await modsApi.getTrackedMods()
            setMods(retry.mods || [])
            setFetchError(null)
          } catch (error) {
            reportClientError('Failed to retry tracked mods fetch.', error)
            setFetchError('Unable to load the mod list. Use Sync or reload the page to retry.')
          }
        }, 1500)
      }
      if (results[1].status === 'fulfilled') {
        const statusData = results[1].value
        setStatus(statusData)
        // Update restart settings from status
        if (statusData) {
          setRestartWarningMinutes(statusData.restartWarningMinutes || 5)
          setDelayIfPlayersOnline(statusData.delayIfPlayersOnline || false)
          setMaxDelayMinutes(statusData.maxDelayMinutes || 30)
        }
      }
      if (results[2].status === 'fulfilled') {
        setIniConfig(results[2].value)
        // Unsaved Load order moves survive a reload (an update check, a
        // restart event, a mod removed elsewhere on the page).
        if (results[2].value?.modIds) {
          syncOrderFromServer(results[2].value.modIds, opts?.adoptServerOrder === true)
        }
      }
      if (results[3].status === 'fulfilled') {
        setIgnoredMods(Array.isArray(results[3].value) ? results[3].value : [])
      }
      if (results[4].status === 'fulfilled') {
        setIgnoredPairs(Array.isArray(results[4].value) ? results[4].value : [])
      }

      // Check for failures and show persistent error
      const failures = results.filter(r => r.status === 'rejected')
      if (failures.length > 0) {
        failures.forEach((result, index) => {
          reportClientError(`Failed to fetch mods data (index ${index}).`, (result as PromiseRejectedResult).reason)
        })
        if (failures.length === results.length) {
          setFetchError('Failed to load mod data. The backend may be unreachable.')
        }
      }
    } catch (error) {
      reportClientError('Failed to fetch mods data.', error)
      setFetchError('Failed to load mod data. The backend may be unreachable.')
    }
    setInitialLoading(false)
    // After any tracked-mod refresh, re-check the collection chip in the
    // background. The status hook short-circuits if no collection is wired,
    // so this is a no-op for users who don't use the feature.
    fetchCollectionStatusRef.current?.().catch(() => {})
  }, [syncOrderFromServer])

  const handleOpenWorkshopBrowser = useCallback(async () => {
    try {
      const { server } = await serversApi.getActive()
      if (!server) {
        toast({
          title: t('toasts.noActiveServerTitle'),
          description: t('toasts.noActiveServerDesc'),
          variant: 'destructive',
        })
        return
      }
      if (server.isRemote) {
        toast({
          title: t('toasts.remoteServerTitle'),
          description: t('toasts.remoteServerDesc'),
          variant: 'destructive',
        })
        return
      }
      // Said before the folder is picked, not after Save is refused.
      if (!canFilesManage && launchIsOperatorDefined(server)) {
        toast({
          title: t('toasts.couldNotSaveWorkshopPathTitle'),
          description: t('errors:SERVER_LAUNCH_TARGET_ADMIN_ONLY'),
          variant: 'destructive',
        })
        return
      }
      const installPath = server?.installPath?.trim() || ''
      const lastSlash = Math.max(installPath.lastIndexOf('\\'), installPath.lastIndexOf('/'))
      const isStartupScript = /\.(bat|cmd|exe|sh)$/i.test(installPath)
      setWorkshopBrowserInitialPath(
        isStartupScript && lastSlash >= 0 ? installPath.slice(0, lastSlash) : installPath || undefined,
      )
    } catch (error) {
      reportClientWarning('Could not load the active server path before opening the folder browser.', error)
      toast({
        title: t('toasts.couldNotOpenBrowserTitle'),
        description: getUserErrorMessage(error, t('toasts.couldNotOpenBrowserFallback')),
        variant: 'destructive',
      })
      return
    }
    setWorkshopBrowserOpen(true)
  }, [toast, t, canFilesManage])

  const handleWorkshopFolderSelected = useCallback(async (selectedPath: string) => {
    if (savingWorkshopPath || !selectedPath.trim() || !canManageServers) return
    setSavingWorkshopPath(true)
    try {
      const { server } = await serversApi.getActive()
      await serversApi.update(server.id, { installPath: selectedPath.trim() })
      await fetchData()
      toast({ title: t('toasts.workshopPathConnectedTitle'), description: t('toasts.workshopPathConnectedDesc') })
    } catch (error) {
      toast({
        title: t('toasts.couldNotSaveWorkshopPathTitle'),
        description: getUserErrorMessage(error, t('toasts.couldNotSaveWorkshopPathFallback')),
        variant: 'destructive',
      })
    } finally {
      setSavingWorkshopPath(false)
    }
  }, [fetchData, savingWorkshopPath, toast, t, canManageServers])

  // Fetch mods that exist on disk but are NOT in the server INI.
  // Lazy: only called when the user opens the "Show disabled" panel.
  const fetchDisabled = useCallback(async () => {
    setDisabledLoading(true)
    try {
      const result = await modsApi.listDiskOnly()
      setDisabledMods(result.mods || [])
      setDisabledScanned(true)
    } catch (error) {
      reportClientError('Failed to fetch disabled mods.', error)
      toast({
        title: t('disabledPanel.scanFailedTitle'),
        description: t('disabledPanel.scanFailedDesc'),
        variant: 'destructive',
      })
    } finally {
      setDisabledLoading(false)
    }
  }, [toast, t])

  const handleEnableDiskMod = useCallback(async (workshopId: string) => {
    if (enablingId || !canManageMods) return
    setEnablingId(workshopId)
    try {
      const r = await modsApi.enableDiskMod(workshopId)
      toast({
        title: t('toasts.modEnabledTitle'),
        description: t('toasts.modEnabledDesc', { count: r.modIdsAdded }),
      })
      // Refresh both lists so the row moves from disabled → tracked.
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: t('toasts.enableFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.enableFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setEnablingId(null)
    }
  }, [enablingId, toast, fetchData, fetchDisabled, t, canManageMods])

  // Delete a single mod's files from disk (and strip it from the INI).
  // Used by the "Disabled mods on disk" and "Ignored mods" panels.
  const handleDeleteDiskMod = useCallback(async (workshopId: string, modName?: string) => {
    if (deletingId || !canManageMods) return
    const label = modName ? `"${modName}" (${workshopId})` : workshopId
    const ok = await confirm({
      title: t('toasts.deleteModFromDiskTitle'),
      description: t('toasts.deleteModFromDiskDesc', { label }),
      confirmLabel: t('toasts.delete'),
    })
    if (!ok) {
      return
    }
    setDeletingId(workshopId)
    try {
      const r = await modsApi.deleteDiskMod(workshopId)
      toast({
        title: t('toasts.modDeletedTitle'),
        description: r.deletedFromDisk
          ? t('toasts.modDeletedFromDisk', { count: r.modIdsStripped })
          : t('toasts.modDeletedFolderMissing'),
      })
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: t('toasts.deleteFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.deleteFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setDeletingId(null)
    }
  }, [deletingId, toast, fetchData, fetchDisabled, t, canManageMods])

  // Bulk delete all currently shown disabled-on-disk mods.
  const handleDeleteAllDisabled = useCallback(async () => {
    if (deletingId || disabledMods.length === 0 || !canManageMods) return
    const ok = await confirm({
      title: t('toasts.deleteDisabledFromDiskTitle'),
      description: t('toasts.deleteDisabledFromDiskDesc', { count: disabledMods.length }),
      items: disabledMods.map(m => m.name || m.workshop_id),
      confirmLabel: t('toasts.deleteAll'),
    })
    if (!ok) {
      return
    }
    setDeletingId('__batch_disabled__')
    try {
      const ids = disabledMods.map(m => m.workshop_id)
      const r = await modsApi.batchDeleteDiskMods(ids)
      toast({
        title: t('toasts.bulkDeleteCompleteTitle'),
        description: t('toasts.bulkDeleteCompleteDesc', { count: r.total, deleted: r.deletedFromDisk, total: r.total })
          + t('toasts.bulkDeleteCompleteStrippedSuffix', { count: r.modIdsStripped, stripped: r.modIdsStripped }),
      })
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: t('toasts.bulkDeleteFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.bulkDeleteFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setDeletingId(null)
    }
  }, [deletingId, disabledMods, toast, fetchData, fetchDisabled, t, canManageMods])

  // Bulk delete all ignored mods from disk.
  const handleDeleteAllIgnoredFromDisk = useCallback(async () => {
    if (deletingId || ignoredMods.length === 0 || !canManageMods) return
    const ok = await confirm({
      title: t('toasts.deleteIgnoredFromDiskTitle'),
      description: t('toasts.deleteIgnoredFromDiskDesc', { count: ignoredMods.length }),
      items: ignoredMods.map(m => m.name || m.workshop_id),
      confirmLabel: t('toasts.deleteAll'),
    })
    if (!ok) {
      return
    }
    setDeletingId('__batch_ignored__')
    try {
      const ids = ignoredMods.map(m => m.workshop_id)
      const r = await modsApi.batchDeleteDiskMods(ids)
      toast({
        title: t('toasts.bulkDeleteCompleteTitle'),
        description: t('toasts.bulkDeleteCompleteDesc', { count: r.total, deleted: r.deletedFromDisk, total: r.total })
          + t('toasts.bulkDeleteCompleteStrippedSuffix', { count: r.modIdsStripped, stripped: r.modIdsStripped }),
      })
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: t('toasts.bulkDeleteFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.bulkDeleteFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setDeletingId(null)
    }
  }, [deletingId, ignoredMods, toast, fetchData, fetchDisabled, t, canManageMods])

  // Fetch the workshop-collection diff. Cheap one-shot read; only updates the
  // header indicator. Errors are stored on state so the user can see why
  // sync isn't reflecting their changes.
  //
  // We use a ref to break the dependency cycle between fetchData and
  // fetchCollectionStatus: every fetchData() call schedules a status refresh
  // (so adding/removing a tracked mod auto-refreshes the chip) without
  // re-creating fetchData on every render.
  const fetchCollectionStatusRef = useRef<() => Promise<void>>(async () => {})
  // Guard so we stop re-fetching if the user has no collection wired up
  // (avoids hammering the diff endpoint on every fetchData()).
  const collectionEverConfiguredRef = useRef(true)
  const fetchCollectionStatus = useCallback(async () => {
    if (!collectionEverConfiguredRef.current) return
    setCollectionStatus((s) => ({ ...s, loading: true }))
    try {
      const r = await modsApi.collectionDiff()
      collectionEverConfiguredRef.current = !!r.collectionId
      setCollectionStatus({
        configured: !!r.collectionId,
        autoSync: !!r.autoSync,
        inSync: r.ok && r.toAdd.length === 0 && r.toRemove.length === 0,
        drift: r.ok ? r.toAdd.length + r.toRemove.length : 0,
        title: r.title || null,
        error: r.ok ? null : (r.error || null),
        loading: false,
      })
    } catch (err: any) {
      setCollectionStatus((s) => ({ ...s, loading: false, error: getUserErrorMessage(err, 'Network error') }))
    }
  }, [])

  // Keep the ref pointing at the latest implementation so fetchData can
  // call it without taking it as a dependency.
  useEffect(() => {
    fetchCollectionStatusRef.current = fetchCollectionStatus
  }, [fetchCollectionStatus])

  // If the user wires up a collection in Settings *after* opening the Mods
  // page, the gate above (collectionEverConfiguredRef = false) would keep
  // the chip hidden until full reload. Re-arm the gate when the tab gains
  // focus so a freshly-saved config gets discovered.
  useEffect(() => {
    const onFocus = () => {
      if (!collectionEverConfiguredRef.current) {
        collectionEverConfiguredRef.current = true
        fetchCollectionStatusRef.current?.().catch(() => {})
      }
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [])

  const handleCollectionSyncNow = useCallback(async () => {
    if (collectionSyncing || !canManageMods) return
    setCollectionSyncing(true)
    try {
      const r = await modsApi.collectionSync()
      toast({
        title: r.success ? t('toasts.collectionSyncedTitle') : t('toasts.partialSyncTitle'),
        description: r.message,
        variant: r.success ? 'default' : 'destructive',
      })
    } catch (err: any) {
      toast({ variant: 'destructive', title: t('toasts.syncFailedTitle'), description: getUserErrorMessage(err, t('toasts.unknownError')) })
    } finally {
      setCollectionSyncing(false)
      // A partial sync (some items added, then Steam refused one) arrives as
      // an error: the chip must still show what is left, not the old count.
      void fetchCollectionStatus()
    }
  }, [collectionSyncing, fetchCollectionStatus, toast, t, canManageMods])

  // Fetch mod presets
  const fetchPresets = useCallback(async () => {
    setPresetsLoading(true)
    try {
      const data = await modsApi.getPresets()
      setPresets(data.presets || [])
    } catch (error) {
      reportClientError('Failed to fetch presets.', error)
      setFetchError('Failed to load presets')
    } finally {
      setPresetsLoading(false)
    }
  }, [])

  // Initial data fetch + auto sync from server
  // Subscribe to Socket.IO mod events for real-time status updates
  const socket = useSocket()
  useEffect(() => {
    if (!socket) return
    const refresh = () => { fetchData() }
    socket.on('mods:update_detected', refresh)
    socket.on('mods:restart_pending', refresh)
    socket.on('mods:restart_starting', refresh)
    socket.on('mods:restart_cancelled', refresh)
    socket.on('mods:restart_failed', refresh)
    socket.on('mods:restart_complete', refresh)
    socket.on('mods:updates_available', refresh)
    return () => {
      socket.off('mods:update_detected', refresh)
      socket.off('mods:restart_pending', refresh)
      socket.off('mods:restart_starting', refresh)
      socket.off('mods:restart_cancelled', refresh)
      socket.off('mods:restart_failed', refresh)
      socket.off('mods:restart_complete', refresh)
      socket.off('mods:updates_available', refresh)
    }
  }, [socket, fetchData])

  useEffect(() => {
    let mounted = true
    const initializeData = async () => {
      await Promise.allSettled([fetchData(), fetchPresets(), fetchCollectionStatus()])
      if (!mounted) return
      // Load cached conflict scan results (if any) so the Conflicts tab isn't blank
      try {
        const cached = await modsApi.getCachedConflicts()
        if (!mounted) return
        if (cached) {
          setConflicts(cached)
          setConflictsError(null) // clear any stale error from a previous session
          setLastScanTime(new Date()) // approximate — exact time isn't stored
          // Set a snapshot so stale detection works when modIds change after cached load
          setScanIniSnapshot(createConflictScanSnapshot(cached._workshopIdsSnapshot, cached._modIdsSnapshot))
          if (cached.stale) {
            // Config changed since last scan — the stale banner will show
          }
        }
      } catch { /* non-fatal — user can still trigger a fresh scan */ }
    }
    initializeData()
    return () => { mounted = false }
  }, [fetchData, fetchPresets, fetchCollectionStatus])

  const handleSavePreset = async () => {
    if (!presetName.trim() || !canManageMods) return
    setSavingPreset(true)
    try {
      await modsApi.createPreset(presetName.trim(), presetDescription.trim())
      toast({
        title: t('toasts.presetSavedTitle'),
        description: t('toasts.presetSavedDesc', { name: presetName }),
        variant: 'success' as const,
      })
      setSavePresetOpen(false)
      setPresetName('')
      setPresetDescription('')
      fetchPresets()
    } catch (error) {
      toast({
        title: t('toasts.presetSaveFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.presetSaveFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setSavingPreset(false)
    }
  }

  const handleApplyPreset = async (id: number, _name: string) => {
    if (!canManageMods) return
    setApplyingPreset(id)
    // An applied preset replaces Mods=: the list then shows its order.
    let applied = false
    try {
      const result = await modsApi.applyPreset(id)
      applied = true
      toast({
        title: t('toasts.presetAppliedTitle'),
        description: result.message,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toasts.presetApplyFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.presetApplyFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setApplyingPreset(null)
      // Always resync — not because the apply can partially succeed (the
      // server route merges both INI lines in memory and writes them in one
      // fs.writeFileSync call, so it's all-or-nothing), but so the UI
      // reflects the confirmed server-side config rather than a local guess,
      // even after a failed attempt.
      fetchData({ adoptServerOrder: applied })
    }
  }

  const handleDeletePreset = async (id: number, name: string) => {
    if (!canManageMods) return
    try {
      await modsApi.deletePreset(id)
      toast({
        title: t('toasts.presetDeletedTitle'),
        description: t('toasts.presetDeletedDesc', { name }),
        variant: 'success' as const,
      })
      fetchPresets()
    } catch (error) {
      toast({
        title: t('toasts.presetDeleteFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.presetDeleteFailedFallback')),
        variant: 'destructive',
      })
    }
  }

  // ── Lookups shared by every view ──────────────────────────────────────────
  // Workshop item -> its mod IDs, mod ID -> its item and name (from the
  // server's mod.info files, then the tracked mods' Workshop titles).
  const { wsModIds, modIdNameMap, modIdWsMap, availableModIds } = useMemo(() => {
    const byWs = new Map<string, string[]>()
    const names = new Map<string, string>()
    const owner = new Map<string, string>()
    const wsMap = iniConfig?.workshopModMap || {}
    for (const [wsId, details] of Object.entries(wsMap)) {
      byWs.set(wsId, details.map((m) => m.id))
      for (const m of details) {
        if (m.name && m.name !== m.id) names.set(m.id, m.name)
        owner.set(m.id, wsId)
      }
    }
    for (const mod of mods) {
      for (const m of wsMap[mod.workshop_id] ?? []) {
        if (!names.has(m.id) && mod.name) names.set(m.id, mod.name)
      }
    }
    return { wsModIds: byWs, modIdNameMap: names, modIdWsMap: owner, availableModIds: new Set(owner.keys()) }
  }, [iniConfig?.workshopModMap, mods])
  const modNamesRecord = useMemo(() => Object.fromEntries(modIdNameMap), [modIdNameMap])
  const enabledModIds = useMemo(() => new Set(iniConfig?.modIds ?? []), [iniConfig?.modIds])
  const trackedByWs = useMemo(() => new Map(mods.map((m) => [m.workshop_id, m])), [mods])
  const groupIds = useMemo(() => groupsStore.groups.map((group) => group.id), [groupsStore.groups])
  const groupsOfWorkshop = useCallback(
    (wsId: string) => groupsOfMods(wsModIds.get(wsId) ?? [], groupsStore.membership),
    [wsModIds, groupsStore.membership],
  )
  const groupIdsOfWorkshop = useCallback((wsId: string) => groupsOfWorkshop(wsId).map((group) => group.id), [groupsOfWorkshop])
  const requiresMap = useMemo(() => buildRequiresMap(iniConfig?.workshopModMap), [iniConfig?.workshopModMap])

  // Group mods by status for scannable display.
  // Mods that are tracked but no longer present in the server INI's
  // WorkshopItems= list are routed to a separate "Deactivated" bucket so
  // they don't pollute the active server view.
  const configuredWorkshopIds = useMemo(() => new Set(iniConfig?.workshopIds || []), [iniConfig?.workshopIds])
  const deactivatedMods = useMemo(() => {
    if (iniConfig === null) return [] as TrackedMod[]
    return sortInstalledMods(mods.filter((mod) => !configuredWorkshopIds.has(mod.workshop_id)), 'name')
  }, [mods, iniConfig, configuredWorkshopIds])
  // The Deactivated list as shown: the shared search (name, Workshop ID, note).
  const shownDeactivated = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase()
    if (!q) return deactivatedMods
    return deactivatedMods.filter((mod) =>
      (mod.name ?? '').toLowerCase().includes(q) || mod.workshop_id.includes(q) || notesStore.noteText(mod.workshop_id).toLowerCase().includes(q))
  }, [deactivatedMods, deferredSearchQuery, notesStore])

  // A remembered "In group" filter whose group was deleted reads as "all".
  const installedGroupFilter = useMemo(() => parseGroupFilter(installedFilters.group, groupIds), [installedFilters.group, groupIds])
  // Installed: tracked mods that are in the server config, searched (names,
  // IDs, notes), filtered by the chips and sorted.
  const installedMods = useMemo(
    () => modsOnServer(mods, iniConfig === null ? null : configuredWorkshopIds),
    [mods, iniConfig, configuredWorkshopIds],
  )
  // The Installed list's own updates: what its counts show, so "Updates
  // only" never lists nothing under a count of 1 (a Deactivated item's
  // update, e.g. a Workshop item no longer in WorkshopItems=).
  const installedModsWithUpdates = useMemo(() => installedMods.filter((mod) => mod.update_available), [installedMods])
  const filteredMods = useMemo(() => {
    const filtered = filterInstalledMods(
      installedMods,
      deferredSearchQuery,
      { updatesOnly: showUpdatesOnly, hasNote: installedFilters.hasNote, group: installedGroupFilter },
      { noteText: notesStore.noteText, groupIdsOf: groupIdsOfWorkshop },
    )
    return sortInstalledMods(filtered, installedSort)
  }, [installedMods, deferredSearchQuery, showUpdatesOnly, installedFilters.hasNote, installedGroupFilter, notesStore.noteText, groupIdsOfWorkshop, installedSort])

  const groupedMods = useMemo(() => {
    const updateAvailable: TrackedMod[] = []
    const neverChecked: TrackedMod[] = []
    const upToDate: TrackedMod[] = []
    for (const mod of filteredMods) {
      if (mod.update_available) updateAvailable.push(mod)
      else if (!mod.last_checked) neverChecked.push(mod)
      else upToDate.push(mod)
    }
    return { updateAvailable, neverChecked, upToDate, deactivated: deactivatedMods }
  }, [filteredMods, deactivatedMods])

  const visibleServerMods = useMemo(
    () => (installedSort === 'status' ? [...groupedMods.updateAvailable, ...groupedMods.neverChecked, ...groupedMods.upToDate] : filteredMods),
    [groupedMods, filteredMods, installedSort]
  )

  // status.removedWorkshopIds contains Workshop IDs still present in tracking
  // after Steam confirmed EResult 9 (FileNotFound); removed subscriptions are
  // filtered server-side so this warning disappears after the X action.
  const removedWorkshopMods = useMemo(() => {
    const byId = new Map(mods.map((m) => [m.workshop_id, m]))
    return (status?.removedWorkshopIds || []).map((id) => ({
      workshopId: id,
      name: byId.get(id)?.name || null,
    }))
  }, [status?.removedWorkshopIds, mods])

  // Collapse "up-to-date" by default, expand when searching
  const [upToDateExpanded, setUpToDateExpanded] = useState(false)
  // Collapse "never checked" by default — it's an alphabetical dump until a check has run
  const [neverCheckedExpanded, setNeverCheckedExpanded] = useState(false)
  // Reset collapse when search changes
  useEffect(() => {
    if (deferredSearchQuery) {
      setUpToDateExpanded(true)
      setNeverCheckedExpanded(true)
    } else {
      setUpToDateExpanded(false)
      setNeverCheckedExpanded(false)
    }
  }, [deferredSearchQuery])

  // If "Never Checked" is the only non-empty bucket (e.g. fresh server, first
  // load before any update check has run), auto-expand it. Otherwise the user
  // sees an empty-looking list with just a collapsed header — the mods ARE
  // tracked, they just aren't visible.
  useEffect(() => {
    if (deferredSearchQuery) return
    if (
      groupedMods.neverChecked.length > 0 &&
      groupedMods.updateAvailable.length === 0 &&
      groupedMods.upToDate.length === 0
    ) {
      setNeverCheckedExpanded(true)
    }
  }, [groupedMods, deferredSearchQuery])

  const handleCheckUpdates = async () => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setChecking(true)
    try {
      const result = await modsApi.checkUpdates()
      // Backend returns `{ updated, mods, error?, skipped? }`. Older code read
      // `result.updatesFound` which never existed → always reported 0.
      const count =
        (Array.isArray(result?.mods) ? result.mods.length : 0) ||
        (typeof result?.updatesFound === 'number' ? result.updatesFound : 0)
      // MODS_CHECK_UPDATES_ACF_NOT_FOUND is the normal, permanent state for a
      // non-Steam/GOG install (GitHub #148) -- there is no Workshop ACF file
      // to find, ever, and that's not a failure the operator caused or can
      // "fix". It's also indistinguishable server-side from a legitimate
      // SteamCMD install that has never downloaded a Workshop mod, so this
      // shows an accurate, non-alarming explanation instead of the raw
      // "Workshop ACF file not found" string in a red error toast.
      const workshopAcfNotFoundMessage =
        result?.code === 'MODS_CHECK_UPDATES_ACF_NOT_FOUND'
          ? resolveRegisteredTranslation('errors', result.code, undefined)
          : null
      await fetchData()
      if (count > 0) setShowUpdatesOnly(true)

      if (workshopAcfNotFoundMessage) {
        toast({
          title: t('toasts.workshopDataUnavailableTitle'),
          description: workshopAcfNotFoundMessage,
          variant: 'default',
        })
      } else if (result?.error) {
        // bug-hunt-2026-09-18 (round 14, raw result.error sweep): this
        // branch is only reached for modChecker.js's checkForUpdates()
        // outer catch-all (`{ error: error.message }`, no code today --
        // the ACF_NOT_FOUND case above is filtered out first) -- but
        // nothing prevents a future code being added to that catch.
        // getResultErrorMessage() (not getUserErrorMessage() -- `result` is
        // a parsed response body, not a caught ApiError, so
        // getUserErrorMessage()'s params extraction can't see it; see that
        // function's own comment, found via this same round's Debug.tsx
        // fix) is byte-identical to the old String(result.error) when no
        // code resolves, so applying it here costs nothing today and stops
        // a later server-side code addition -- including one with a
        // {{placeholder}} -- from being shown raw or half-translated forever.
        toast({
          title: t('toasts.updateCheckFailedTitle'),
          description: getResultErrorMessage(result, String(result.error)),
          variant: 'destructive',
        })
      } else if (result?.skipped) {
        toast({
          title: t('toasts.updateCheckSkippedTitle'),
          description: t('toasts.updateCheckSkippedDesc'),
        })
      } else {
        toast({
          title: t('toasts.updatesCheckedTitle'),
          description:
            count === 0
              ? t('toasts.allModsUpToDate')
              : t('toasts.modsHaveUpdates', { count }),
        })
      }
    } catch (error) {
      toast({
        title: t('toasts.updateCheckFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.updateCheckFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setChecking(false)
      busyRef.current = false
    }
  }

  const discoverWorkshopMod = useCallback(async (workshopId: string) => {
    // Prevent double-triggering
    if (discoveringMod || !canManageMods) return

    // Abort any previous discovery request
    discoverAbortRef.current?.abort()
    const controller = new AbortController()
    discoverAbortRef.current = controller

    // Check if already configured
    if (iniConfig?.workshopIds?.includes(workshopId)) {
      toast({
        title: t('toasts.alreadyAddedTitle'),
        description: t('toasts.alreadyAddedDesc'),
        variant: 'default',
      })
      return
    }

    setDiscoveringMod(true)
    setDiscoveredMod(null)
    setSelectedModIds(new Set())

    try {
      // download: an item the server does not have yet is fetched with SteamCMD so its
      // mod IDs are known now and get enabled with it (otherwise it is only added to
      // WorkshopItems= and the server downloads it on a later boot, too late to enable it).
      const result = await modsApi.discoverModIds(workshopId, undefined, { signal: controller.signal, download: true })
      // Superseded, or the dialog was closed: this result belongs to nobody
      // now and must not fill a reopened dialog.
      if (controller.signal.aborted) return

      // Filter out duplicate mod IDs (case-insensitive)
      const seenIds = new Set<string>()
      const uniqueModIds = result.modIds.filter(id => {
        const lower = id.toLowerCase()
        if (seenIds.has(lower)) return false
        seenIds.add(lower)
        return true
      })

      // Check which mod IDs are already in config
      const alreadyConfigured = uniqueModIds.filter(id =>
        iniConfig?.modIds?.includes(id)
      )

      const newResult = {
        ...result,
        modIds: uniqueModIds,
        hasMultipleModIds: uniqueModIds.length > 1,
        alreadyConfigured,
        isAlreadyAdded: iniConfig?.workshopIds?.includes(workshopId) || false,
      }

      setDiscoveredMod(newResult)

      // Pre-select only NEW mod IDs (not already configured)
      const newModIds = uniqueModIds.filter(id => !alreadyConfigured.includes(id))
      setSelectedModIds(new Set(newModIds))

      if (uniqueModIds.length === 0) {
        toast({
          title: t('toasts.noModIdsFoundTitle'),
          description: result.isDownloaded
            ? t('toasts.noModIdsDownloadedDesc')
            : t('toasts.noModIdsNotDownloadedDesc'),
          variant: 'default',
        })
      } else if (alreadyConfigured.length > 0 && alreadyConfigured.length === uniqueModIds.length) {
        toast({
          title: t('toasts.alreadyConfiguredTitle'),
          description: t('toasts.alreadyConfiguredDesc'),
          variant: 'default',
        })
      } else if (newResult.hasMultipleModIds) {
        toast({
          title: t('toasts.multipleModIdsFoundTitle'),
          description: t('toasts.multipleModIdsFoundDesc', { count: uniqueModIds.length, newCount: newModIds.length, configuredCount: alreadyConfigured.length }),
        })
      }
    } catch (error) {
      // Superseded by a newer request, or the dialog was closed. (The request
      // layer reports an abort as its own error type, so the signal is the
      // reliable test.)
      if (controller.signal.aborted) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      toast({
        title: t('toasts.discoveryFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.discoveryFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      // Closing the dialog already reset this; a newer discovery owns it.
      if (discoverAbortRef.current === controller) {
        discoverAbortRef.current = null
        setDiscoveringMod(false)
      }
    }
  }, [discoveringMod, iniConfig?.modIds, iniConfig?.workshopIds, toast, t, canManageMods])

  // Auto-discover on paste (debounced)
  const handleModInputChange = useCallback((value: string) => {
    setAdvancedModInput(value)

    if (autoDiscoverTimeoutRef.current) {
      clearTimeout(autoDiscoverTimeoutRef.current)
      autoDiscoverTimeoutRef.current = null
    }

    if (value.includes('steamcommunity.com') && value.includes('id=')) {
      const workshopId = parseWorkshopId(value)

      if (workshopId && workshopId !== lastAutoDiscoverIdRef.current) {
        lastAutoDiscoverIdRef.current = workshopId
        autoDiscoverTimeoutRef.current = setTimeout(() => {
          void discoverWorkshopMod(workshopId)
        }, 200)
      }
    }
  }, [discoverWorkshopMod])

  // Discover mod IDs from workshop URL/ID
  const handleDiscoverMod = async () => {
    if (!canManageMods) return
    const workshopId = parseWorkshopId(advancedModInput)

    if (!workshopId) {
      toast({
        title: t('toasts.invalidWorkshopUrlTitle'),
        description: t('toasts.invalidWorkshopUrlDesc'),
        variant: 'destructive',
      })
      return
    }

    await discoverWorkshopMod(workshopId)
  }

  // Add mod with selected mod IDs
  const handleAddModAdvanced = async () => {
    if (!discoveredMod || busyRef.current || !canManageMods) return
    if (pendingAddServerChanged) {
      toast({
        title: modsFallback('toasts.pendingAddServerChangedTitle', 'Active server changed'),
        description: modsFallback(
          'toasts.pendingAddServerChangedDesc',
          'The active server changed while you had mods queued to add. The IDs and map folders shown were looked up for the previous server -- close this dialog and start over for the server that is active now.',
        ),
        variant: 'destructive',
      })
      return
    }
    busyRef.current = true

    setLoading(true)
    try {
      const modIdsArray = Array.from(selectedModIds)

      // Track the mod first
      await modsApi.trackMod(discoveredMod.workshopId)

      // Add with selected mod IDs
      const result = await modsApi.addModAdvanced(
        discoveredMod.workshopId,
        modIdsArray.length > 0 ? modIdsArray : undefined,
        modIdsArray.length === 0 // If no mod IDs selected, try to include all
      )

      if (result.addedModIds.length > 0) {
        toast({
          title: t('toasts.modAddedToConfigTitle'),
          description: t('toasts.modAddedToConfigDesc', {
            ids: result.addedModIds.join(', '),
            maps: result.mapFoldersAdded.length > 0
              ? t('toasts.mapsAddedSuffix', { count: result.mapFoldersAdded.length, names: result.mapFoldersAdded.join(', ') })
              : '',
          }),
          variant: 'success' as const,
        })
      } else if (result.status === 'workshop-only') {
        // No mod ID is known yet (not downloaded, Steam had none): only
        // WorkshopItems= changed, so the mod will not load until the ID is
        // known. Say what to do instead of promising it will be discovered.
        toast({
          title: t('toasts.workshopIdAddedTitle'),
          description: t('toasts.workshopOnlyDesc'),
        })
      } else if (result.workshopAlreadyExisted) {
        toast({
          title: t('toasts.alreadyConfiguredTitle'),
          description: t('toasts.workshopAlreadyExistsDesc'),
        })
      } else {
        toast({
          title: t('toasts.workshopIdAddedTitle'),
          description: t('toasts.workshopIdAddedDesc'),
        })
      }

      // Reset and close
      setAdvancedModInput('')
      setDiscoveredMod(null)
      setSelectedModIds(new Set())
      setAdvancedAddDialogOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.addModFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.addModFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  // Toggle mod ID selection
  const toggleModIdSelection = (modId: string) => {
    setSelectedModIds(prev => {
      const next = new Set(prev)
      if (next.has(modId)) {
        next.delete(modId)
      } else {
        next.add(modId)
      }
      return next
    })
  }
  const handleRemoveMod = async (workshopId: string) => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.batchRemove([workshopId])
      toast({
        title: t('toasts.modRemovedTitle'),
        description: t('toasts.modRemovedDesc'),
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.removeFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.removeFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  // Re-enable a deactivated tracked mod by appending its workshop ID to the
  // server INI's WorkshopItems= list. SteamCMD will (re)download it on next
  // server start if the workshop folder isn't already on disk.
  const handleEnableMod = async (workshopId: string) => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.addToIni(workshopId)
      // continuous-bug-hunt round 27 (mod load order / Workshop collection
      // import): a workshop item can declare several mod.info `id=` lines --
      // addToIni only ever auto-enables the first one (by design, see its
      // own comment server-side) and now reports the rest as
      // alternativeModIds instead of silently discarding that information.
      // Without this, an operator re-enabling a multi-mod workshop item had
      // no way to learn the other mods existed at all.
      const alternatives: string[] = result?.alternativeModIds || []
      toast({
        title: t('toasts.modReEnabledTitle'),
        description: alternatives.length > 0
          ? t('toasts.modReEnabledDesc') + t('toasts.additionalModsFoundSuffix', { count: alternatives.length, ids: alternatives.join(', ') })
          : t('toasts.modReEnabledDesc'),
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.enableFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.enableFailedFallbackShort')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  // Bulk: re-enable every selected deactivated mod in ONE ini write (one
  // backup) through the bulk endpoint. One addToIni call per mod meant one
  // backup per mod, and only the newest 10 backups are kept.
  const handleBulkEnable = async (workshopIds: string[]) => {
    if (workshopIds.length === 0 || busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.addToIniBulk(workshopIds.map((workshopId) => ({ workshopId })))
      const results = result.results ?? []
      const failed = results.filter((r) => r.status === 'invalid').length
      const ok = workshopIds.length - failed
      // continuous-bug-hunt round 27: same alternativeModIds surfacing as
      // handleEnableMod above, aggregated across every workshop item in this
      // batch rather than lost per-call.
      const allAlternatives = results.flatMap((r) => r.alternativeModIds ?? [])
      const workshopOnly = results.filter((r) => r.status === 'workshop-only').length
      toast({
        title: failed === 0 ? t('toasts.modsReEnabledTitle') : t('toasts.partialReEnableTitle'),
        description: t('toasts.reEnabledDesc', { count: ok, failedSuffix: failed > 0 ? t('toasts.reEnableFailedSuffix', { count: failed }) : '' })
          + (allAlternatives.length > 0 ? t('toasts.additionalModsFoundSuffix', { count: allAlternatives.length, ids: allAlternatives.join(', ') }) : '')
          + (workshopOnly > 0 ? ` ${t('toasts.workshopOnlyNote', { count: workshopOnly })}` : ''),
        variant: failed === 0 ? ('success' as const) : ('destructive' as const),
      })
      setSelectedMods(new Set())
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.enableFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.enableFailedFallbackShort')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleRefreshNames = async (workshopIds?: string[]) => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.refreshNames(workshopIds)
      const total = result.totalResolved ?? 0
      const left = result.unresolved ?? 0
      toast({
        title: total > 0 ? t('toasts.resolvedNames', { count: total }) : t('toasts.noNewNamesFound'),
        description: total > 0
          ? t('toasts.resolvedFromDiskAndSteam', { disk: result.diskResolved, steam: result.steamResolved, unresolvedSuffix: left > 0 ? t('toasts.stillUnknownSuffix', { count: left }) : '' })
          : t('toasts.checkedPlaceholders', { count: result.checked }),
        variant: total > 0 ? ('success' as const) : ('default' as const),
      })
      if (total > 0) fetchData()
    } catch (error: any) {
      toast({
        title: t('toasts.refreshFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.refreshFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleBulkRemove = async (workshopIdsOverride?: string[]) => {
    const workshopIds = workshopIdsOverride ?? Array.from(selectedMods)
    if (workshopIds.length === 0 || busyRef.current || !canManageMods) return
    busyRef.current = true

    setLoading(true)

    try {
      const result = await modsApi.batchRemove(workshopIds) as { success?: boolean; total?: number; dbRemoved?: number; dbFailed?: number; iniRemoved?: number; error?: string }

      if (result.error) {
        throw new Error(result.error)
      }

      if ((result.dbFailed ?? 0) > 0) {
        toast({
          title: t('toasts.partialSuccessTitle'),
          description: t('toasts.partialSuccessDesc', { removed: result.dbRemoved ?? 0, failed: result.dbFailed ?? 0 }),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('toasts.removeSuccessTitle'),
          description: t('toasts.removeSuccessDesc', { count: result.total ?? workshopIds.length }),
        })
      }
      if (workshopIdsOverride) {
        setSelectedMods(prev => {
          const next = new Set(prev)
          for (const workshopId of workshopIds) next.delete(workshopId)
          return next
        })
      } else {
        setSelectedMods(new Set())
      }
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.removeFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.removeFailedMultiFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleUnignoreMod = async (workshopId: string) => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.unignoreMod(workshopId)
      toast({ title: t('toasts.modUnIgnoredTitle'), description: t('toasts.modUnIgnoredDesc') })
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.unIgnoreFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.unknownError')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const toggleIgnoredSelect = useCallback((workshopId: string) => {
    setSelectedIgnored(prev => {
      const next = new Set(prev)
      if (next.has(workshopId)) next.delete(workshopId)
      else next.add(workshopId)
      return next
    })
  }, [])

  // Drop selections whose entry is gone (after a refresh, a clear or a server switch).
  useEffect(() => {
    setSelectedIgnored(prev => {
      if (prev.size === 0) return prev
      const present = new Set(ignoredMods.map(m => m.workshop_id))
      const next = new Set([...prev].filter(id => present.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [ignoredMods])

  const handleUnignoreSelected = async () => {
    if (busyRef.current || !canManageMods || selectedIgnored.size === 0) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.unignoreMods([...selectedIgnored])
      setSelectedIgnored(new Set())
      toast({
        title: t('toasts.ignoreSelectedRemovedTitle'),
        description: t('toasts.ignoreSelectedRemovedDesc', { n: result?.removed ?? 0 }),
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.unIgnoreFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.unknownError')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleClearAllIgnored = async () => {
    if (busyRef.current || !canManageMods) return
    const confirmed = await confirm({
      title: t('toasts.clearIgnoredConfirmTitle'),
      description: t('toasts.clearIgnoredConfirmDesc', { n: ignoredMods.length }),
      confirmLabel: t('toasts.clearIgnoredConfirmLabel'),
    })
    if (!confirmed) return
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.clearAllIgnoredMods()
      toast({ title: t('toasts.ignoreListClearedTitle'), description: result.message || t('toasts.ignoreListClearedFallback') })
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.clearIgnoredFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.unknownError')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleToggleAutoRestart = async () => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.setAutoRestart(!status?.autoRestartEnabled)
      toast({
        title: status?.autoRestartEnabled ? t('toasts.autoRestartDisabled') : t('toasts.autoRestartEnabled'),
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.settingUpdateFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.settingUpdateFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleSyncFromServer = async () => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.syncFromServer()
      const parts: string[] = [t('toasts.syncedFromServer', { count: result.synced || 0 })]
      if (result.skippedNonMod > 0) parts.push(t('toasts.skippedNonMod', { count: result.skippedNonMod }))
      if (result.skippedIgnored > 0) parts.push(t('toasts.skippedIgnored', { count: result.skippedIgnored }))
      // Sentence separator/terminator is a language property, not something
      // every locale's untranslated fragment can be assumed to want a Latin
      // ". " for -- zh-CN / zh-TW's own fragments carry no punctuation and expect a
      // full-width terminator instead.
      const sentenceEnd = i18n.language.startsWith('zh') ? '。' : '. '
      toast({
        title: t('toasts.modsSyncedTitle'),
        description: parts.join(sentenceEnd) + sentenceEnd.trim(),
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.syncFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.syncFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleImportCollection = async () => {
    if (!canManageMods) return
    if (!collectionUrl) {
      toast({
        title: t('toasts.noUrlEnteredTitle'),
        description: t('toasts.noUrlEnteredDesc'),
        variant: 'destructive',
      })
      return
    }
    // Validate format before sending to API
    const trimmed = collectionUrl.trim()
    if (!/^\d{1,15}$/.test(trimmed) && !trimmed.includes('steamcommunity.com')) {
      toast({
        title: t('toasts.invalidFormatTitle'),
        description: t('toasts.invalidFormatDesc'),
        variant: 'destructive',
      })
      return
    }
    if (busyRef.current) return
    busyRef.current = true

    setImportingCollection(true)
    try {
      const result = await modsApi.importCollection(collectionUrl)
      const mods = result.mods || []
      const existingWorkshopIds = new Set(iniConfig?.workshopIds || [])
      setCollectionMods(mods.map((m: CollectionMod) => ({
        ...m,
        selected: !existingWorkshopIds.has(m.workshopId),
        modId: '',
        // Do not guess the folder from the Steam title: the real folder lives
        // in the mod's media/maps directory and rarely matches. A wrong value
        // written to Map= stops the world from loading.
        mapFolder: undefined
      })))
      setCollectionImported(true)

      const subCollectionCount = (result.subCollectionIds || []).length

      if (mods.length === 0) {
        toast({
          title: t('toasts.noModsFoundInCollectionTitle'),
          description: subCollectionCount > 0
            ? t('toasts.collectionOnlySubCollectionsDesc', { count: subCollectionCount })
            : t('toasts.noModsFoundInCollectionDesc'),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('toasts.modsFoundTitle', { count: mods.length }),
          description: subCollectionCount > 0
            ? t('toasts.modsFoundDescWithSkipped', { count: subCollectionCount })
            : t('toasts.modsFoundDesc'),
        })
      }
    } catch (error) {
      toast({
        title: t('toasts.collectionImportFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.collectionImportFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setImportingCollection(false)
      busyRef.current = false
    }
  }

  const toggleModSelection = (workshopId: string) => {
    setCollectionMods(prev => prev.map(m =>
      m.workshopId === workshopId ? { ...m, selected: !m.selected } : m
    ))
  }

  const updateModId = (workshopId: string, modId: string) => {
    setCollectionMods(prev => prev.map(m =>
      m.workshopId === workshopId ? { ...m, modId } : m
    ))
  }

  const updateMapFolder = (workshopId: string, mapFolder: string) => {
    setCollectionMods(prev => prev.map(m =>
      m.workshopId === workshopId ? { ...m, mapFolder } : m
    ))
  }

  const handleAddCollectionMods = async () => {
    if (!canManageMods) return
    if (pendingAddServerChanged) {
      toast({
        title: modsFallback('toasts.pendingAddServerChangedTitle', 'Active server changed'),
        description: modsFallback(
          'toasts.pendingAddServerChangedDesc',
          'The active server changed while you had mods queued to add. The IDs and map folders shown were looked up for the previous server -- close this dialog and start over for the server that is active now.',
        ),
        variant: 'destructive',
      })
      return
    }
    const selectedModsList = collectionMods.filter(m => m.selected)

    if (selectedModsList.length === 0) {
      toast({
        title: t('toasts.noModsSelectedTitle'),
        description: t('toasts.noModsSelectedDesc'),
        variant: 'destructive',
      })
      return
    }

    setLoading(true)
    try {
      // Every selected mod goes to the server in ONE request, which edits the
      // .ini once (workshopId + mod IDs + map folders) and so takes one backup.
      // One request per mod meant one backup per mod, and a backup keeps only
      // the newest 10: a 60-mod import pushed the pre-import config out.
      const bulk = await modsApi.addToIniBulk(
        selectedModsList.map((mod) => {
          const selectedModIds = mod.modId ? [mod.modId] : undefined
          return {
            workshopId: mod.workshopId,
            selectedModIds,
            includeAllModIds: !selectedModIds, // every mod of the item when no explicit modId was set
          }
        }),
        true, // track each mod (and mirror into the Workshop collection if auto-sync is on)
      )

      const results = bulk.results ?? []
      const invalid = results.filter(r => r.status === 'invalid')
      const failed = invalid.length
      const added = selectedModsList.length - failed
      invalid.forEach((item) => {
        reportClientWarning(`Failed to add mod ${item.workshopId}.`, item.code)
      })
      // "Restart to load" is only true for mods that got a mod ID. One that
      // was not downloaded and has no ID yet only went into WorkshopItems=.
      const workshopOnly = results.filter(r => r.status === 'workshop-only').length
      const needsRestart = results.length === 0 || results.some(r => r.status === 'added')

      toast({
        title: t('toasts.modsAddedToConfigTitle', { count: added }),
        description: [
          failed > 0 ? t('toasts.modsAddedFailedSuffix', { count: failed }) : null,
          failed === 0 && needsRestart ? t('toasts.restartToLoadNewMods') : null,
          workshopOnly > 0 ? t('toasts.workshopOnlyNote', { count: workshopOnly }) : null,
        ].filter(Boolean).join(' '),
        variant: failed > 0 ? 'destructive' : 'success' as const,
      })

      setCollectionDialogOpen(false)
      setCollectionMods([])
      setCollectionUrl('')
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.importFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.importFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }


  // Sync mod IDs from downloaded workshop mods to the Mods= line in server.ini
  const handleSyncModIds = async () => {
    if (!canManageMods) return
    setSyncing(true)
    try {
      const result = await modsApi.syncModIds()

      const synced = result.syncedMods?.filter((m: { status?: string }) => m.status?.startsWith('added')).length || 0
      const missing = result.missingMods?.length || 0
      // continuous-bug-hunt round 27: /sync-mod-ids already computed
      // `alternatives` per workshop item (other mod.info `id=` entries it
      // declared, beyond the one default it auto-enabled) -- this page
      // never read that field at all. Aggregate and surface it the same
      // way as handleEnableMod/handleBulkEnable above.
      const alternatives: string[] = (result.syncedMods || [])
        .flatMap((m: { alternatives?: string[] }) => m.alternatives || [])

      if (synced > 0 || missing > 0) {
        toast({
          title: t('toasts.modIdsSyncedTitle'),
          description: t('toasts.modIdsSyncedDesc', { synced, missingSuffix: missing > 0 ? t('toasts.modIdsSyncedMissingSuffix', { count: missing }) : '' })
            + (alternatives.length > 0 ? t('toasts.additionalModsFoundSuffix', { count: alternatives.length, ids: alternatives.join(', ') }) : ''),
        })
      } else {
        toast({
          title: t('toasts.alreadySyncedTitle'),
          description: t('toasts.alreadySyncedDesc'),
        })
      }

      // Refresh ini config display
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.modIdSyncFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.modIdSyncFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setSyncing(false)
    }
  }

  // Drag & drop handlers for mod load order. Reordering is local until Save,
  // but Save needs mods.manage, so every reorder path (drag, the move
  // controls, auto-sort) is gated on it too rather than letting a role
  // without it build an order the server will refuse to write.
  //
  // Manual reordering is also locked while Save Order is in flight or an
  // Auto-sort proposal is open, the two states Auto-sort's own button is
  // already disabled for: a move made then would be silently thrown away --
  // the save's reload overwrites orderedModIds with what the server wrote,
  // and Apply writes the proposal computed from the order as it was.
  //
  // The list itself (components/mods/LoadOrderList) guards every move and
  // drag with these too, so a lost dragend can't reorder behind a lock.
  const loadOrderLocked = savingModOrder || autoSortPreview !== null

  // Smart sort: the server's planner (routes/modsSmart.js) plans the order on
  // screen, unsaved moves included, from require=, order rules, groups and
  // their placement, mod.info hints, Steam "Required items", patches and the
  // current conflict winners. A proposal only: Apply changes the list here,
  // Save Order writes it.
  const handleAutoSort = () => {
    if (!canManageMods || savingModOrder) return
    void smart.smartSort.open(orderedModIds)
  }

  // "Sort now" from a conflict suggestion or "Why is it here?".
  const openSmartSort = () => {
    if (!canManageMods || savingModOrder) return
    selectView('order')
    void smart.smartSort.open(orderedModIds)
  }

  const applyAutoSort = () => {
    if (!autoSortPreview || !canManageMods) return
    const { plan, input } = autoSortPreview
    // The list is locked while the proposal is open; a reload under it would
    // have replaced the order the proposal was made from.
    if (input.join('\n') !== orderedModIds.join('\n')) {
      smart.smartSort.close()
      return
    }
    setOrderedModIds(plan.order)
    smart.smartSort.close()
    toast({
      title: t('toasts.autoSortAppliedTitle'),
      description: t('toasts.autoSortAppliedDesc', { count: plan.moves.length }),
    })
  }

  const handleSaveModOrder = async () => {
    if (busyRef.current || !canManageMods) return
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }
    busyRef.current = true
    try {
      setSavingModOrder(true)
      // Mods= may have changed since this page read it (another admin or tab,
      // the Discord bot): writing this list as it is would undo that, putting
      // back a mod they disabled or dropping one they enabled. Read it again
      // first; when mods came or went, merge them in and let the admin look.
      const base = savedModIdsRef.current
      const live = await modsApi.getCurrentConfig()
      if (live?.configured && Array.isArray(live.modIds) && !sameLoadOrderEntries(live.modIds, base)) {
        setIniConfig(live)
        syncOrderFromServer(live.modIds)
        toast({
          title: t('toasts.serverModsChangedTitle'),
          description: t('toasts.serverModsChangedDesc'),
          variant: 'warning',
        })
        return
      }
      const saved = await modsApi.saveModOrder(orderedModIds)
      // With "Keep group order" on, the server may have moved group members
      // (groupsAdjusted): what it wrote is then not orderedModIds, so the
      // conflict winners are not recalculated from it -- the scan reads as
      // out of date against the reloaded INI instead.
      if (!(saved?.groupsAdjusted?.length)) {
        setConflicts(prev => prev ? recalculateConflictWinners(prev, orderedModIds) : prev)
        setScanIniSnapshot(createConflictScanSnapshot(iniConfig?.workshopIds, orderedModIds))
      }
      toast({
        title: t('toasts.modOrderSavedTitle'),
        description: t('toasts.modOrderSavedDesc'),
      })
      noticeGroupOrder(saved)
      // Awaited (fetchData never throws) so savingModOrder -- which locks
      // drag and the row move controls -- stays set until this reload has
      // replaced orderedModIds with what the server wrote. Released any
      // earlier, a move made in that window was overwritten a moment later,
      // and for that round-trip the footer still said "Unsaved order
      // changes" with Save enabled again. What the server wrote is the list
      // now (it may have moved group members back into group order).
      await fetchData({ adoptServerOrder: true })
    } catch (error) {
      toast({
        title: t('toasts.saveOrderFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.saveOrderFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setSavingModOrder(false)
      busyRef.current = false
    }
  }

  // Move winnerModId in the load order so it loads AFTER loserModId.
  // Used by the inline "Make X win" buttons inside each conflict pair card.
  // Saves immediately and optimistically updates the conflict scan's load-order map
  // so the winner indicators flip without a full rescan.
  //
  // continuous-bug-hunt: this calls modsApi.saveModOrder() exactly like
  // handleSaveModOrder above, which resolves the active server fresh
  // server-side per request (see that function's own bug-hunt-2026-09-04/05
  // comment) -- the identical cross-server-write hazard. handleSaveModOrder
  // guards it with serverChangedSinceLoad, but this path didn't: switch
  // active server while a reorder is pending (which is what sets
  // serverChangedSinceLoad and blocks fetchData, per the effect below), then
  // click "Make X win" on a conflict pair computed from the now-stale
  // iniConfig/orderedModIds -- it would write server A's stale order into
  // server B's real INI with no warning at all. Same guard, same message.
  const promoteModOverOpponent = async (winnerModId: string, winnerName: string, loserModId: string, loserName: string) => {
    if (busyRef.current || !canManageMods) return
    if (serverChangedSinceLoad) {
      toast({
        title: t('toasts.serverChangedSinceLoadTitle'),
        description: t('toasts.serverChangedSinceLoadDesc'),
        variant: 'destructive',
      })
      return
    }
    // It saves at once from the saved order: unsaved Load order moves would
    // be written over without a word.
    if (hasModOrderChanged) {
      toast({
        title: t('toasts.couldNotUpdateLoadOrderTitle'),
        description: tGroups('enable.unsavedOrder'),
        variant: 'destructive',
      })
      return
    }
    const source = (iniConfig?.modIds && iniConfig.modIds.length > 0) ? iniConfig.modIds : orderedModIds
    const next = [...source]
    const wi = next.indexOf(winnerModId)
    if (wi === -1 || next.indexOf(loserModId) === -1) {
      toast({
        title: t('toasts.cannotReorderTitle'),
        description: t('toasts.cannotReorderDesc'),
        variant: 'destructive',
      })
      return
    }
    next.splice(wi, 1)
    const newLi = next.indexOf(loserModId)
    next.splice(newLi + 1, 0, winnerModId)

    busyRef.current = true
    try {
      setSavingModOrder(true)
      const saved = await modsApi.saveModOrder(next)
      setOrderedModIds(next)
      // Same as handleSaveModOrder: group members the server moved back into
      // group order mean `next` is not what was written.
      if (!(saved?.groupsAdjusted?.length)) {
        setConflicts(prev => prev ? recalculateConflictWinners(prev, next) : prev)
        setScanIniSnapshot(createConflictScanSnapshot(iniConfig?.workshopIds, next))
      }
      toast({
        title: t('toasts.loadOrderUpdatedTitle'),
        description: t('toasts.loadOrderUpdatedDesc', { winner: winnerName, loser: loserName }),
      })
      noticeGroupOrder(saved)
      // Awaited for the same reason as in handleSaveModOrder: savingModOrder
      // also locks the Load Order tab, and a move made there before this
      // reload lands would be overwritten by it.
      await fetchData({ adoptServerOrder: true })
    } catch (error) {
      toast({
        title: t('toasts.couldNotUpdateLoadOrderTitle'),
        description: getUserErrorMessage(error, t('toasts.saveOrderFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setSavingModOrder(false)
      busyRef.current = false
    }
  }

  const hasModOrderChanged = useMemo(() => {
    if (!iniConfig?.modIds) return false
    if (orderedModIds.length !== iniConfig.modIds.length) return true // Different count = changed
    return orderedModIds.some((id, i) => id !== iniConfig.modIds[i])
  }, [orderedModIds, iniConfig?.modIds])

  // See serverChangedSinceLoad's own comment above. Unlike the other
  // mods:* socket events above (which always just refetch), fetchData()
  // unconditionally overwrites orderedModIds from the server's real list --
  // safe when there's no pending reorder, but a silent discard of the
  // user's unsaved work if hasModOrderChanged is true. Mirrors Settings.tsx's
  // dirty-guard shape for the reload itself, ServerConfig's block-and-warn
  // shape for the save action above.
  useEffect(() => {
    if (!socket) return
    const handleActiveServerChanged = () => {
      // pz-bughunt round 17b (approved design call, closing the "race-
      // window" class flagged in the round-17 report): toggleModId,
      // batchToggleModIds, deleteDiskMod, batchDeleteDiskMods, batchRemove,
      // removeFromIni, enableDiskMod all read their target id from a row in
      // mods/disabledMods/ignoredMods rendered from the OLD server's data.
      // Between this switch firing and fetchData() actually resolving
      // below, those rows stayed fully visible and clickable, so a click in
      // that window sent the OLD server's id as a write against the NEW
      // active server. Rather than add a serverChangedSinceLoad-style check
      // to seven separate handlers, clear the stale lists outright the
      // moment the switch happens -- the same shape WorldMap.tsx already
      // uses for its own player/vehicle/safehouse selection state: nothing
      // stale survives to be clicked, so no per-handler guard is needed.
      // Unconditional (not gated on hasModOrderChanged/pendingAddServerChanged
      // below) since none of these three lists is what either of those
      // guards protects -- orderedModIds/discoveredMod/collectionMods are
      // untouched here, so a pending reorder or add-dialog stays intact.
      setMods([])
      setDisabledMods([])
      setDisabledScanned(false)
      setIgnoredMods([])
      setSelectedIgnored(new Set())
      setSelectedActiveWs(new Set())
      setConflictsFocus(null)

      // The conflict scan and an open Auto-sort proposal describe the old
      // server's mods. Applied and saved, the proposal wrote the old server's
      // whole Mods= into the new one; the scan's winners fed the group
      // badges, Auto-sort and "Make X win". The new server is scanned anew.
      closeSmartSort()
      if (eventSourceRef.current) {
        closingIntentionallyRef.current = true
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      sseIdleTimerRef.current = null
      cancelAnimationFrame(scanBatchRef.current.raf)
      setConflicts(null)
      setConflictsLoading(false)
      setConflictsError(null)
      setLastScanTime(null)
      setScanIniSnapshot(null)
      setStreamConflicts([])

      // pz-bughunt round 18: depSearchOpen/depSearchData/depAdding/
      // depAddResults are the SAME lifted state used by both this page's
      // own "Active on server" inspector (handleInspectorAddDep, a few
      // hundred lines below) and ConflictsPanel.tsx's handleAddDep (passed
      // down as props) -- both call modsApi.addMissingDep(hit.workshopId,
      // ...) with search hits looked up in the context of a SPECIFIC mod
      // inside a SPECIFIC server's own conflict/dependency data. Clearing
      // here closes the identical race-window shape for both surfaces at
      // once, the same reasoning as the mods/disabledMods/ignoredMods
      // clear just above.
      setDepSearchOpen(new Set())
      setDepSearchData({})
      setDepAdding([])
      setDepAddResults({})

      // pz-bughunt round 18: the restart-settings dialog's editable fields
      // (restartWarningMinutes/delayIfPlayersOnline/maxDelayMinutes) are
      // populated from THIS server's status at fetch time (see fetchData's
      // own setRestartWarningMinutes/etc. calls) and handleSaveRestartSettings
      // writes them via modsApi.setRestartOptions(), which resolves "the
      // active server" server-side with no id sent. If the dialog stays
      // open across a switch, saving would write the OLD server's edited
      // values into the NEW one. Same fix as Backups.tsx's own
      // activeServerChanged handler closing its restore/delete/delete-older
      // dialogs on this same event -- close it outright rather than add a
      // fourth bespoke guard flag+toast for one small settings dialog.
      setRestartSettingsOpen(false)

      // See pendingAddServerChanged's own comment above -- independent of
      // the reorder guard below, doesn't block fetchData() (neither dialog's
      // state is derived from iniConfig/mods, so a refetch can't discard it).
      if (discoveredMod !== null || collectionMods.length > 0) {
        setPendingAddServerChanged(true)
        toast({
          title: modsFallback('toasts.pendingAddServerChangedTitle', 'Active server changed'),
          description: modsFallback(
            'toasts.pendingAddServerChangedDesc',
            'The active server changed while you had mods queued to add. The IDs and map folders shown were looked up for the previous server -- close this dialog and start over for the server that is active now.',
          ),
          variant: 'destructive',
        })
      }
      if (hasModOrderChanged) {
        setServerChangedSinceLoad(true)
        toast({
          title: t('toasts.serverChangedSinceLoadTitle'),
          description: t('toasts.serverChangedSinceLoadDesc'),
          variant: 'destructive',
        })
        return
      }
      fetchData()
    }
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, fetchData, hasModOrderChanged, discoveredMod, collectionMods.length, toast, t, closeSmartSort])

  // Once the user discards the stale reorder (the "Reset" button sets
  // orderedModIds back to iniConfig.modIds, making hasModOrderChanged
  // false again), the block above no longer applies -- clear it and pick
  // up the new server's real data, same as the safe branch above would
  // have done immediately if there'd been nothing to protect.
  useEffect(() => {
    if (serverChangedSinceLoad && !hasModOrderChanged) {
      setServerChangedSinceLoad(false)
      fetchData()
    }
  }, [serverChangedSinceLoad, hasModOrderChanged, fetchData])

  // Same idea for the add-mod guard: once both dialogs are closed/cleared
  // (Cancel, a successful Add, or the collection review being cleared), the
  // stale-lookup risk is gone -- drop the flag so a later switch doesn't
  // leave the NEXT open of either dialog wrongly pre-blocked.
  useEffect(() => {
    if (pendingAddServerChanged && discoveredMod === null && collectionMods.length === 0) {
      setPendingAddServerChanged(false)
    }
  }, [pendingAddServerChanged, discoveredMod, collectionMods.length])


  const openWorkshopPage = (workshopId: string) => {
    window.open(`https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`, '_blank', 'noopener,noreferrer')
  }

  const toggleModSelect = useCallback((workshopId: string) => {
    setSelectedMods(prev => {
      const newSet = new Set(prev)
      if (newSet.has(workshopId)) {
        newSet.delete(workshopId)
      } else {
        newSet.add(workshopId)
      }
      return newSet
    })
  }, [])

  const selectAllVisible = () => {
    setSelectedMods(new Set(visibleServerMods.map(mod => mod.workshop_id)))
  }

  const deselectAll = () => {
    setSelectedMods(new Set())
  }

  const handleSaveRestartSettings = async () => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.setRestartOptions({
        warningMinutes: restartWarningMinutes,
        delayIfPlayersOnline: delayIfPlayersOnline,
        maxDelayMinutes: maxDelayMinutes
      })
      toast({
        title: t('toasts.settingsSavedTitle'),
        description: t('toasts.settingsSavedDesc'),
      })
      setRestartSettingsOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.settingsSaveFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.settingsSaveFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleCancelPendingRestart = async () => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.cancelPendingRestart()
      toast({
        title: t('toasts.restartCancelledTitle'),
        description: t('toasts.restartCancelledDesc'),
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toasts.cancelFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.cancelFailedFallback')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  // Every tracked mod flagged with an update, Deactivated ones too: only for
  // the stale-flag check below, whose Steam count includes them. The
  // Installed counts use installedModsWithUpdates.
  const modsWithUpdates = useMemo(() => mods.filter(m => m.update_available), [mods])
  const selectedCollectionCount = useMemo(() => collectionMods.filter(m => m.selected).length, [collectionMods])

  // Render a single mod row — extracted to avoid duplication across groups.
  // Hover-reveal pattern: action cluster + checkbox stay hidden until the row
  // gets hover/focus or when any selection is active. Keeps the resting state
  // calm while still being one keystroke/cursor away from the controls.
  const renderModRow = useCallback((mod: TrackedMod) => {
    const isSelected = selectedMods.has(mod.workshop_id)
    const inConfig = configuredWorkshopIds.has(mod.workshop_id)
    const anySelected = selectedMods.size > 0
    const label = mod.name || t('installedTab.modFallback', { id: mod.workshop_id })
    const revealClass = isSelected || anySelected
      ? 'opacity-100'
      // A touch screen has no hover: the controls stay visible there.
      : 'opacity-0 group-hover/modrow:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100'
    return (
      <ModRow
        key={mod.id}
        selected={isSelected}
        leading={
          <div className="flex items-center gap-3">
            <div className={`transition-opacity ${revealClass}`}>
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => toggleModSelect(mod.workshop_id)}
                aria-label={t('installedTab.selectAria', { name: label })}
              />
            </div>
            {/* Leading tile carries the per-mod state colour (update / unchecked / up-to-date). */}
            <WorkshopThumb
              wsId={mod.workshop_id}
              label={label}
              demo={demoMode}
              tone={
                mod.update_available
                  ? 'border-warning/40 bg-warning/10 text-warning'
                  : !mod.last_checked
                    ? 'border-border/50 bg-muted/30 text-muted-foreground'
                    : 'border-primary/25 bg-primary/[0.06] text-primary/85'
              }
              fallbackIcon={<Package className="h-8 w-8" aria-hidden="true" />}
            />
          </div>
        }
        title={
          <span className={`truncate text-sm ${mod.update_available ? 'font-semibold text-foreground' : 'font-medium text-foreground/95'}`}>
            {label}
          </span>
        }
        titleBadges={
          <>
            {/* "Not in Config" first — a mod that can't load is a bigger problem than a stale one. */}
            {!inConfig && (
              <Badge variant="outline" className="h-5 shrink-0 border-destructive/40 bg-destructive/5 text-[10px] text-destructive">
                {t('installedTab.notInConfig')}
              </Badge>
            )}
            {mod.update_available ? (
              <Badge variant="warning" className="update-badge-pulse h-5 shrink-0 gap-1 text-[10px]">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" aria-hidden="true" />
                {t('installedTab.update')}
              </Badge>
            ) : null}
            <GroupDots groups={groupsOfWorkshop(mod.workshop_id)} />
            <NoteIndicator note={notesStore.notes[mod.workshop_id]} onOpen={() => setNoteEditor({ workshopId: mod.workshop_id, name: label })} />
          </>
        }
        meta={
          <>
            <WorkshopIdChip
              wsId={mod.workshop_id}
              onCopied={(id) => toast({ title: t('installedTab.copiedTitle'), description: t('installedTab.copiedWorkshopId', { id }) })}
            />
            {mod.update_available ? (
              <a
                href={changelogUrl(mod.workshop_id)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="inline-flex items-center gap-1 rounded text-[11px] font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={t('whatChanged.aria', { name: label })}
              >
                <History className="h-3 w-3" aria-hidden="true" />
                {t('whatChanged.label')}
              </a>
            ) : null}
            {mod.last_checked ? (
              <span>{t('installedTab.checkedOn', { date: formatDate(mod.last_checked) })}</span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded border border-dashed border-muted-foreground/30 bg-muted/20 px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground/80">
                <span className="inline-block h-1 w-1 rounded-full bg-muted-foreground/60" aria-hidden="true" />
                {t('installedTab.unchecked')}
              </span>
            )}
          </>
        }
        actions={
          <div className={`flex items-center gap-0.5 transition-opacity ${revealClass}`}>
            <WorkshopLinkAction wsId={mod.workshop_id} label={label} hint={t('installedTab.openWorkshopPageHint')} />
            <RowActions
              ariaLabel={t('rowMenu.actionsAria', { name: label })}
              items={[
                ...groupMenuItems(wsModIds.get(mod.workshop_id) ?? [], label),
                noteMenuItem(mod.workshop_id, label),
                {
                  label: t('installedTab.removeFromServer'),
                  icon: Trash2,
                  destructive: true,
                  onSelect: () => setConfirmRemoveMod({ wsId: mod.workshop_id, label }),
                  disabled: loading || !canManageMods,
                  reason: !canManageMods ? t('permissions.noModsManage') : undefined,
                },
              ]}
            />
          </div>
        }
      />
    )
  // groupMenuItems / noteMenuItem are plain functions of the same state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, selectedMods, configuredWorkshopIds, loading, toggleModSelect, toast, t, formatDate, wsModIds, groupsOfWorkshop, notesStore.notes, canManageMods, groupsStore.groups])

  // ── Virtualized tracked mods list ──
  type StatusBucket = 'update' | 'neverChecked' | 'upToDate' | 'flat'
  type FlatModItem =
    | { type: 'header'; group: StatusBucket; count: number }
    | { type: 'hint' }
    | { type: 'mod'; mod: TrackedMod; group: StatusBucket }

  const modListRef = useRef<HTMLDivElement>(null)

  const flatModItems = useMemo<FlatModItem[]>(() => {
    const items: FlatModItem[] = []
    // Sorted by name or update time: one flat list, no status buckets.
    if (installedSort !== 'status') {
      for (const mod of filteredMods) items.push({ type: 'mod', mod, group: 'flat' })
      return items
    }
    if (groupedMods.updateAvailable.length > 0) {
      items.push({ type: 'header', group: 'update', count: groupedMods.updateAvailable.length })
      for (const mod of groupedMods.updateAvailable) items.push({ type: 'mod', mod, group: 'update' })
    }
    if (groupedMods.neverChecked.length > 0) {
      items.push({ type: 'header', group: 'neverChecked', count: groupedMods.neverChecked.length })
      if (groupedMods.updateAvailable.length === 0 && groupedMods.upToDate.length === 0 && !searchQuery) {
        items.push({ type: 'hint' })
      }
      if (neverCheckedExpanded) {
        for (const mod of groupedMods.neverChecked) items.push({ type: 'mod', mod, group: 'neverChecked' })
      }
    }
    if (groupedMods.upToDate.length > 0) {
      items.push({ type: 'header', group: 'upToDate', count: groupedMods.upToDate.length })
      if (upToDateExpanded) {
        for (const mod of groupedMods.upToDate) items.push({ type: 'mod', mod, group: 'upToDate' })
      }
    }
    return items
  }, [groupedMods, searchQuery, upToDateExpanded, neverCheckedExpanded, installedSort, filteredMods])

  const modListVirtualizer = useVirtualizer({
    count: flatModItems.length,
    getScrollElement: () => modListRef.current,
    estimateSize: (i) => flatModItems[i].type === 'mod' ? 96 : flatModItems[i].type === 'hint' ? 48 : 40,
    overscan: 10,
  })

  // ── Active Mods sub-tab: memoized derived data ──
  const activeModsData = useMemo(() => {
    const wsMap = iniConfig?.workshopModMap || {}
    const groups: WsGroup[] = []
    for (const wsId of (iniConfig?.workshopIds || [])) {
      const details = wsMap[wsId] || []
      if (details.length === 0) continue
      groups.push({
        wsId,
        mods: details,
        allEnabled: details.every(m => m.enabled),
        someEnabled: details.some(m => m.enabled),
      })
    }
    const allModsList = groups.flatMap(g => g.mods)
    const mappedIds = new Set(allModsList.map(m => m.id))
    const enabledIds = new Set(allModsList.filter(m => m.enabled).map(m => m.id))
    const orphaned = (iniConfig?.modIds || []).filter(id => !mappedIds.has(id))
    // Add orphaned enabled IDs so dependency checks can find them
    for (const id of orphaned) enabledIds.add(id)
    const enabledCount = enabledIds.size
    const multiIdCount = groups.filter(g => g.mods.length > 1).length

    // Build missing-deps map: modId → list of required mod IDs not currently enabled.
    // Resolution (exact id, or a "<required>_<suffix>" / "<required>-<suffix>" fork)
    // is shared with the load-order auto-sort so the two can't disagree.
    const resolveRequirement = createRequirementResolver(enabledIds)
    const isRequireSatisfied = (req: string) => resolveRequirement(req) !== null
    const missingDepsMap = new Map<string, string[]>()
    for (const g of groups) {
      for (const mod of g.mods) {
        if (!mod.require?.length || !mod.enabled) continue
        const missing = mod.require.filter(r => !isRequireSatisfied(r))
        if (missing.length > 0) missingDepsMap.set(mod.id, missing)
      }
    }

    // Build duplicate mod ID map: modId → list of wsIds that provide it
    const modIdProviders = new Map<string, string[]>()
    for (const g of groups) {
      for (const mod of g.mods) {
        const list = modIdProviders.get(mod.id) || []
        list.push(g.wsId)
        modIdProviders.set(mod.id, list)
      }
    }
    const duplicateModIds = new Map<string, string[]>()
    for (const [modId, wsIds] of modIdProviders) {
      if (wsIds.length > 1) duplicateModIds.set(modId, wsIds)
    }

    return { groups, orphaned, enabledCount, multiIdCount, missingDepsMap, duplicateModIds }
  }, [iniConfig?.workshopModMap, iniConfig?.workshopIds, iniConfig?.modIds])

  // ── Sibling conflicts: within a single workshop item, which mod IDs overlap
  //    with each other? These are typically alternatives (e.g. NUDE vs DOLL
  //    texture variants) — usually only one should be enabled at a time.
  //    Pairs the user has dismissed as false positives are excluded so the
  //    Advanced tab doesn't keep nagging about library + dependant combos. ──
  const ignoredPairKeys = useMemo(() => {
    const s = new Set<string>()
    for (const p of ignoredPairs) {
      const a = p.mod_a, b = p.mod_b
      s.add(a < b ? `${a}--${b}` : `${b}--${a}`)
    }
    return s
  }, [ignoredPairs])
  const isPairIgnored = useCallback((a: string, b: string) => {
    return ignoredPairKeys.has(a < b ? `${a}--${b}` : `${b}--${a}`)
  }, [ignoredPairKeys])
  // A base and its add-on (require= / loadModAfter=) are never variants, nor
  // mods sharing only translation keys (lib/modVariants.ts).
  const siblingConflictsMap = useMemo(
    () => computeVariantSiblings(conflicts?.pairs, activeModsData.groups, isPairIgnored),
    [conflicts?.pairs, activeModsData, isPairIgnored],
  )

  // Search covers the Workshop ID, every mod ID and name, and the item's note.
  const activeModsFiltered = useMemo(() => {
    const filteredGroups = activeModsData.groups
      .map((g) => matchesActiveSearch(g, deferredModManagerSearch, notesStore.noteText))
      .filter((g): g is WsGroup => g !== null)
    return { filteredGroups }
  }, [activeModsData, deferredModManagerSearch, notesStore.noteText])

  // What warrants a red flag on an Active item: two enabled variants the
  // scanner confirmed overlap, an enabled mod whose required ID isn't loaded,
  // or an ID claimed by two Workshop items. A partial "1 of 5 enabled" is
  // normal and is NOT a problem.
  const groupAttention = useCallback((g: WsGroup) => {
    const { missingDepsMap, duplicateModIds } = activeModsData
    const enabledSet = new Set(g.mods.filter(m => m.enabled).map(m => m.id))
    const siblings = siblingConflictsMap.get(g.wsId)
    let clash = false
    if (siblings) {
      for (const [modId, sibs] of siblings) {
        if (!enabledSet.has(modId)) continue
        for (const s of sibs) if (enabledSet.has(s)) { clash = true; break }
        if (clash) break
      }
    }
    const missing = g.mods.some(m => m.enabled && (missingDepsMap.get(m.id)?.length ?? 0) > 0)
    const duplicate = g.mods.some(m => duplicateModIds.has(m.id))
    return { clash, missing, duplicate, any: clash || missing || duplicate }
  }, [activeModsData, siblingConflictsMap])

  const activeGroupFilter = useMemo(() => parseGroupFilter(activeFilters.group, groupIds), [activeFilters.group, groupIds])
  const multiIdFilterOn = filterMultiId && activeModsData.multiIdCount > 0
  // The Active list as shown: searched, filtered by every chip, then sorted.
  const displayGroups = useMemo(() => {
    const filtered = filterActiveItems(
      activeModsFiltered.filteredGroups,
      {
        attention: filterAttention,
        multiId: multiIdFilterOn,
        notEnabled: filterNotEnabled,
        updates: activeFilters.updates,
        missingDep: activeFilters.missingDep,
        hasNote: activeFilters.hasNote,
        group: activeGroupFilter,
        kind: activeKind,
      },
      {
        needsAttention: (g) => groupAttention(g).any,
        hasUpdate: (wsId) => !!trackedByWs.get(wsId)?.update_available,
        hasMissingDep: (g) => g.mods.some((m) => m.enabled && (activeModsData.missingDepsMap.get(m.id)?.length ?? 0) > 0),
        noteText: notesStore.noteText,
        groupIdsOf: groupIdsOfWorkshop,
        kindsOf: (g) => g.mods.filter((m) => m.enabled).map((m) => smartInsightOf(m.id)?.kind ?? 'unknown'),
      },
    )
    const loadIndex = new Map((iniConfig?.modIds ?? []).map((id, i) => [id, i]))
    return sortActiveItems(filtered, activeSort, {
      loadIndex: (g) => Math.min(Infinity, ...g.mods.map((m) => loadIndex.get(m.id) ?? Infinity)),
      name: (g) => (g.mods[0]?.name !== g.mods[0]?.id ? g.mods[0]?.name : g.mods[0]?.id) ?? g.wsId,
      updatedAt: (wsId) => {
        const time = Date.parse(trackedByWs.get(wsId)?.last_updated ?? '')
        return Number.isFinite(time) ? time : 0
      },
    })
  }, [activeModsFiltered, filterAttention, multiIdFilterOn, filterNotEnabled, activeFilters, activeGroupFilter, groupAttention, trackedByWs, activeModsData, notesStore.noteText, groupIdsOfWorkshop, iniConfig?.modIds, activeSort, activeKind, smartInsightOf])

  // Counts for the Active chips (over the whole list, not the filtered one).
  const activeCounts = useMemo(() => {
    const { groups, missingDepsMap, orphaned } = activeModsData
    return {
      // Enabled IDs no Workshop item on disk ships need attention too (they never load).
      attention: groups.filter((g) => groupAttention(g).any).length + orphaned.length,
      notEnabled: groups.reduce((sum, g) => sum + g.mods.filter((m) => !m.enabled).length, 0),
      updates: groups.filter((g) => !!trackedByWs.get(g.wsId)?.update_available).length,
      missingDep: groups.filter((g) => g.mods.some((m) => m.enabled && (missingDepsMap.get(m.id)?.length ?? 0) > 0)).length,
      hasNote: groups.filter((g) => !!notesStore.noteText(g.wsId)).length,
      ungrouped: groups.filter((g) => groupIdsOfWorkshop(g.wsId).length === 0).length,
    }
  }, [activeModsData, groupAttention, trackedByWs, notesStore, groupIdsOfWorkshop])

  // Items per kind, for the Kind filter (an item counts once per kind it has enabled).
  const kindCounts = useMemo(() => {
    const counts = new Map<ModKind, number>()
    for (const g of activeModsData.groups) {
      const kinds = new Set(g.mods.filter((m) => m.enabled).map((m) => smartInsightOf(m.id)?.kind).filter((k): k is ModKind => !!k))
      for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    return counts
  }, [activeModsData, smartInsightOf])

  // File conflicts touching each group, from the cached conflict scan.
  const conflictsByGroup = useMemo(
    () => summarizeGroupConflicts(groupsStore.groups, conflicts?.pairs ?? []),
    [groupsStore.groups, conflicts?.pairs],
  )

  // ── Groups and notes, from any row ─────────────────────────────────────────

  /** "Add to group…" and one "Remove from <group>" per group, for a row's mod IDs. */
  const groupMenuItems = (modIds: readonly string[], label: string): RowActionItem[] => {
    const known = modIds.length > 0
    const items: RowActionItem[] = [{
      label: tGroups('addTo.menuItem'),
      icon: FolderPlus,
      onSelect: () => setAddToGroup({ modIds: [...modIds], label }),
      disabled: !canManageMods || !known,
      reason: !canManageMods ? t('permissions.noModsManage') : !known ? tGroups('addTo.noModIds') : undefined,
    }]
    for (const group of groupsOfMods(modIds, groupsStore.membership)) {
      const tooFew = removalLeavesTooFew(group, modIds)
      items.push({
        label: tGroups('removeFrom.menuItem', { name: group.name }),
        icon: FolderMinus,
        onSelect: () => void handleRemoveFromGroup(group, modIds),
        disabled: !canManageMods || tooFew,
        reason: !canManageMods ? t('permissions.noModsManage') : tooFew ? tGroups('removeFrom.tooFew') : undefined,
      })
    }
    return items
  }

  // Reading a note needs nothing more; without mods.manage the dialog is read-only.
  const noteMenuItem = (workshopId: string, label: string): RowActionItem => ({
    label: notesStore.notes[workshopId] ? t('notes.editAction') : t('notes.addAction'),
    icon: StickyNote,
    onSelect: () => setNoteEditor({ workshopId, name: label }),
    disabled: !canManageMods && !notesStore.notes[workshopId],
    reason: !canManageMods && !notesStore.notes[workshopId] ? t('permissions.noModsManage') : undefined,
  })

  const handleRemoveFromGroup = async (group: ModGroup, modIds: readonly string[]) => {
    if (!canManageMods || removalLeavesTooFew(group, modIds)) return
    try {
      await removeModsFromGroup(group, modIds, groupsStore)
      toast({ title: tGroups('removeFrom.doneTitle', { name: group.name }) })
    } catch (error) {
      toast({
        title: tGroups('removeFrom.failedTitle'),
        description: getUserErrorMessage(error, tGroups('removeFrom.failedFallback')),
        variant: 'destructive',
      })
    }
  }

  // Rejections stay in the picker, which shows them.
  const handleAddToGroup = async (group: ModGroup) => {
    if (!addToGroup || !canManageMods) return
    const added = await addModsToGroup(group, addToGroup.modIds, groupsStore)
    toast({ title: tGroups('addTo.doneTitle', { name: group.name }), description: tGroups('addTo.doneDesc', { count: added.length }) })
    if (addToGroup.clearSelection === 'installed') setSelectedMods(new Set())
    if (addToGroup.clearSelection === 'order') setSelectedOrderIds(new Set())
    setAddToGroup(null)
  }

  // Suggestions are made from the active server's mods: read again after a
  // server switch (another ini) or a change of its mod list.
  const suggestionsKey = `${iniConfig?.iniPath ?? ''}|${[...(iniConfig?.modIds ?? [])].sort().join(';')}`
  const activeSuggestions = useGroupSuggestions(activeTab === 'active' && activeMode === 'groups' && canManageMods && groupsStore.loadState === 'ready', suggestionsKey)

  const handleSaveGroup = async (values: ModGroupDialogValues) => {
    const editing = groupEditor?.group ?? null
    await saveGroupValues(values, editing, groupsStore)
    toast(editing
      ? { title: tGroups('toast.updatedTitle'), description: tGroups('toast.updatedDesc', { name: values.name }) }
      : { title: tGroups('toast.createdTitle'), description: tGroups('toast.createdDesc', { name: values.name }) })
    if (groupEditor?.fromSuggestion) void activeSuggestions.reload()
    setGroupEditor(null)
  }

  const handleSaveNote = async (text: string) => {
    if (!noteEditor || !canManageMods) return
    const note = await notesStore.saveNote(noteEditor.workshopId, text)
    toast({ title: note ? t('notes.savedTitle') : t('notes.deletedTitle'), description: noteEditor.name })
    setNoteEditor(null)
  }

  // Enable / Disable every mod of a group: one server write each, then the
  // page reloads the config. Refused while the load order has unsaved moves:
  // the reload would throw them away.
  const handleEnableGroup = async (group: ModGroup) => {
    if (busyRef.current || !canManageMods) return
    if (hasModOrderChanged) {
      toast({ title: tGroups('enable.failedTitle'), description: tGroups('enable.unsavedOrder'), variant: 'destructive' })
      return
    }
    busyRef.current = true
    setBusyGroupId(group.id)
    try {
      const result = await modsApi.enableGroup(group.id)
      const enabled = result?.enabled ?? []
      const missing = result?.missing ?? []
      toast({
        title: enabled.length > 0 ? tGroups('enable.doneTitle', { name: group.name }) : tGroups('enable.nothingTitle'),
        description: [
          enabled.length > 0 ? tGroups('enable.doneDesc', { count: enabled.length }) : tGroups('enable.nothingDesc', { name: group.name }),
          missing.length > 0 ? tGroups('enable.missingNote', { count: missing.length, ids: missing.join(', ') }) : null,
        ].filter(Boolean).join(' '),
        variant: missing.length > 0 ? 'warning' : undefined,
      })
      await fetchData()
      noticeGroupOrder({ groupsAdjusted: result?.groupsAdjusted ?? [] })
    } catch (error) {
      toast({ title: tGroups('enable.failedTitle'), description: getUserErrorMessage(error, tGroups('enable.failedFallback')), variant: 'destructive' })
    } finally {
      busyRef.current = false
      setBusyGroupId(null)
    }
  }

  const handleDisableGroup = async (group: ModGroup) => {
    if (busyRef.current || !canManageMods) return
    if (hasModOrderChanged) {
      toast({ title: tGroups('disable.failedTitle'), description: tGroups('enable.unsavedOrder'), variant: 'destructive' })
      return
    }
    const members = [...new Set(group.modIds)].filter((id) => enabledModIds.has(id))
    // The server keeps a mod that another group lists while that group still
    // has an enabled mod this leaves on (its add-ons need it): say which, before asking.
    const leavingIds = new Set(group.modIds)
    const shared = members.filter((id) =>
      groupsStore.groups.some((other) => other.id !== group.id && other.modIds.includes(id) && other.modIds.some((m) => !leavingIds.has(m) && enabledModIds.has(m))))
    const leaving = members.filter((id) => !shared.includes(id))
    const nameOf = (id: string) => (modIdNameMap.get(id) ? `${id} (${modIdNameMap.get(id)})` : id)
    const ok = await confirm({
      title: tGroups('disable.title', { name: group.name }),
      description: tGroups('disable.description', { count: leaving.length }) +
        (shared.length > 0 ? `\n\n${tGroups('disable.sharedNote', { items: shared.map(nameOf).join(', ') })}` : ''),
      items: leaving.slice(0, 12).map(nameOf),
      confirmLabel: tGroups('disable.confirm'),
      destructive: false,
    })
    if (!ok || busyRef.current) return
    busyRef.current = true
    setBusyGroupId(group.id)
    try {
      const result = await modsApi.disableGroup(group.id, true)
      const disabled = result?.disabled ?? []
      const kept = [...(result?.keptShared ?? []), ...(result?.keptManaged ?? [])]
      toast({
        title: tGroups('disable.doneTitle', { name: group.name }),
        description: tGroups('disable.doneDesc', { count: disabled.length }) +
          (kept.length > 0 ? ` ${tGroups('disable.keptNote', { count: kept.length })}` : ''),
      })
      await fetchData()
    } catch (error) {
      toast({ title: tGroups('disable.failedTitle'), description: getUserErrorMessage(error, tGroups('disable.failedFallback')), variant: 'destructive' })
    } finally {
      busyRef.current = false
      setBusyGroupId(null)
    }
  }

  const { apply: applyGroupOrder, applying: applyingGroupOrder } = useApplyGroupOrder({
    groupsById: groupsStore.groupsById,
    modNames: modNamesRecord,
    onApplied: fetchData,
    onChecked: groupsStore.reloadStatus,
  })
  const applyOrderReason = !canManageMods
    ? t('permissions.noModsManage')
    : hasModOrderChanged
      ? tGroups('panel.applyDisabledDirty')
      : savingModOrder || applyingGroupOrder
        ? tGroups('panel.applyDisabledBusy')
        : groupsStore.status?.inOrder
          ? tGroups('panel.applyDisabledInOrder')
          : null

  // A group's conflict badge opens the Conflicts view filtered to its mods.
  const showGroupConflicts = (group: ModGroup, summary: GroupConflictSummary) => {
    setConflictsFocus({ label: group.name, modIds: summary.modIds })
    setActiveTab('conflicts')
  }


  const scanConflicts = useCallback(async () => {
    // Close any previous SSE connection
    if (eventSourceRef.current) {
      closingIntentionallyRef.current = true
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    closingIntentionallyRef.current = false

    setConflictsLoading(true)
    setScanProgress(0)
    setScanCurrentMod(null)
    setScanModsScanned(0)
    setScanTotalMods(0)
    setStreamConflicts([])
    // Cancel any pending rAF from previous scan
    cancelAnimationFrame(scanBatchRef.current.raf)
    scanBatchRef.current = { progress: 0, modName: null, modsScanned: 0, dirty: false, raf: 0 }

    const token = getAccessToken()
    // SSE doesn't support custom headers, so pass token as query param
    const url = `/api/mods/conflicts/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const es = new EventSource(url)
    eventSourceRef.current = es

    // Idle timeout: if no SSE events arrive for 90s, assume connection is dead
    const resetIdleTimer = () => {
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      sseIdleTimerRef.current = setTimeout(() => {
        es.close()
        if (eventSourceRef.current === es) eventSourceRef.current = null
        setConflictsError(t('toasts.scanTimedOut'))
        setConflictsLoading(false)
      }, 90_000)
    }
    resetIdleTimer()

    es.addEventListener('init', (e) => {
      resetIdleTimer()
      try {
        const data = JSON.parse(e.data)
        setConflictsError(null)
        setScanTotalMods(data.totalWorkshopIds || 0)
      } catch (err) { reportClientWarning('SSE init parse error.', err) }
    })

    es.addEventListener('mod-scanned', (e) => {
      resetIdleTimer()
      try {
        const data: ScanStreamModScanned = JSON.parse(e.data)
        // Batch into ref — flush once per frame to avoid 3 setState per SSE event
        const batch = scanBatchRef.current
        batch.progress = data.progress
        batch.modName = data.modName
        batch.modsScanned = data.modsScanned
        if (!batch.dirty) {
          batch.dirty = true
          batch.raf = requestAnimationFrame(() => {
            setScanProgress(batch.progress)
            setScanCurrentMod(batch.modName)
            setScanModsScanned(batch.modsScanned)
            batch.dirty = false
          })
        }
      } catch (err) { reportClientWarning('SSE mod-scanned parse error.', err) }
    })

    es.addEventListener('conflict-found', (e) => {
      resetIdleTimer()
      try {
        const data: ScanStreamConflictFound = JSON.parse(e.data)
        // Keep only the last 50 entries (only 8 are displayed at a time)
        setStreamConflicts(prev => {
          const next = [...prev, data]
          return next.length > 50 ? next.slice(-50) : next
        })
      } catch (err) { reportClientWarning('SSE conflict-found parse error.', err) }
    })

    es.addEventListener('phase', (e) => {
      resetIdleTimer()
      try {
        const data = JSON.parse(e.data)
        setScanProgress(data.progress)
        if (data.phase === 'hashing') setScanCurrentMod(t('toasts.comparingFileContents'))
        if (data.phase === 'grouping') setScanCurrentMod(t('toasts.groupingResults'))
      } catch (err) { reportClientWarning('SSE phase parse error.', err) }
    })

    es.addEventListener('complete', (e) => {
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      try {
        const data = JSON.parse((e as MessageEvent).data)
        // Flush any pending batch before setting final state
        cancelAnimationFrame(scanBatchRef.current.raf)
        scanBatchRef.current.dirty = false
        setConflicts(data)
        setLastScanTime(new Date())
        setScanIniSnapshot(createConflictScanSnapshot(iniConfig?.workshopIds, iniConfig?.modIds))
        setScanProgress(100)
      } catch (err) {
        setConflictsError(t('toasts.scanParseFailed'))
      } finally {
        es.close()
        if (eventSourceRef.current === es) eventSourceRef.current = null
        setConflictsLoading(false)
      }
    })

    es.addEventListener('error', (e) => {
      // Native EventSource fires Event (not MessageEvent) on connection drop.
      // Custom 'error' events from our backend ARE MessageEvents with data.
      if (sseIdleTimerRef.current) clearTimeout(sseIdleTimerRef.current)
      es.close()
      // Only null the ref if this is still the active EventSource (prevents race with re-scan)
      if (eventSourceRef.current === es) eventSourceRef.current = null

      // If we closed intentionally (navigation/unmount), don't show errors.
      // The backend may still finish — cached results will load on re-mount.
      if (closingIntentionallyRef.current) {
        closingIntentionallyRef.current = false
        setConflictsLoading(false)
        return
      }

      const me = e as MessageEvent
      if (typeof me.data === 'string') {
        try {
          const data = JSON.parse(me.data)
          setConflictsError(data.error || t('toasts.scanFailedGeneric'))
        } catch {
          setConflictsError(t('toasts.scanConnectionLost'))
        }
        setConflictsLoading(false)
        toast({ title: t('toasts.scanFailedTitle'), description: t('toasts.scanConnectionLostDesc'), variant: 'destructive' })
      } else {
        // Connection lost — try to recover cached results from backend.
        // Only show the destructive toast if recovery fails; otherwise the
        // user gets a less alarming "showing cached results" notice inline.
        setConflictsLoading(false)
        modsApi.getCachedConflicts().then(cached => {
          if (closingIntentionallyRef.current) return
          if (cached) {
            setConflicts(cached)
            setConflictsError(t('toasts.scanDisconnectedCached'))
          } else {
            setConflictsError(t('toasts.scanConnectionLost'))
            toast({ title: t('toasts.scanFailedTitle'), description: t('toasts.scanConnectionLostDesc'), variant: 'destructive' })
          }
        }).catch(() => {
          if (closingIntentionallyRef.current) return
          setConflictsError(t('toasts.scanConnectionLost'))
          toast({ title: t('toasts.scanFailedTitle'), description: t('toasts.scanConnectionLostDesc'), variant: 'destructive' })
        })
      }
    })
  }, [toast, iniConfig?.workshopIds, iniConfig?.modIds, t])

  useEffect(() => {
    if (!reviewUnresolved || reviewDeepLinkStarted.current) return

    reviewDeepLinkStarted.current = true
    if (!conflicts && !conflictsLoading) void scanConflicts()
  }, [reviewUnresolved, conflicts, conflictsLoading, scanConflicts])

  // ── Active on server: per-item actions ─────────────────────────────────────

  // PanelBridge's own Workshop entry while the active server gets it from the
  // Steam Workshop (spec §4.11): its enable and remove controls are locked,
  // with the badge's text as the reason. Only those -- reordering it stays
  // allowed, as its position in the load order doesn't matter.
  const bridgeLockReason = t('mods.badgeTooltip', { ns: 'bridgeDelivery' })
  const isBridgeGroup = (g: { wsId: string; mods: Array<{ id: string }> }) =>
    isBridgeManagedMod(iniConfig?.bridgeManaged, g.wsId, g.mods.map(m => m.id))

  const toggleMod = async (mod: ModEntry, wsId: string) => {
    if (busyRef.current || !canManageMods) return
    if (isBridgeManagedMod(iniConfig?.bridgeManaged, wsId, [mod.id])) return
    const on = !mod.enabled
    busyRef.current = true
    try {
      await modsApi.toggleModId(mod.id, on)
      setIniConfig(prev => {
        if (!prev) return prev
        const newModIds = on ? [...prev.modIds, mod.id] : prev.modIds.filter(id => id !== mod.id)
        const newMap = { ...prev.workshopModMap }
        if (newMap[wsId]) {
          newMap[wsId] = newMap[wsId].map(m => m.id === mod.id ? { ...m, enabled: on } : m)
        }
        return { ...prev, modIds: newModIds, totalMods: newModIds.length, workshopModMap: newMap }
      })
      setOrderedModIds(prev => on ? [...prev, mod.id] : prev.filter(id => id !== mod.id))
      setLastSavedMod(mod.id)
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current)
      savedTimeoutRef.current = setTimeout(() => setLastSavedMod(null), 2000)
    } catch (e) { reportClientError('Failed to toggle mod', e); toast({ variant: 'destructive', title: t('toasts.failedToToggleModTitle'), description: getUserErrorMessage(e, t('toasts.failedToToggleModFallback')) }) } finally { busyRef.current = false }
  }

  // Mark a sibling-conflict pair as a false positive. Used when the variant
  // detector mis-flags a shared library + dependant (e.g.
  // DynamicTradingCommon vs DynamicTradingV2) as two variants of the same mod.
  const dismissPair = async (a: string, b: string) => {
    if (!canManageMods) return
    try {
      await modsApi.addIgnoredModPair(a, b)
      setIgnoredPairs(prev => {
        const [x, y] = a < b ? [a, b] : [b, a]
        if (prev.some(p => p.mod_a === x && p.mod_b === y)) return prev
        return [...prev, { mod_a: x, mod_b: y, ignored_at: new Date().toISOString() } as any]
      })
      toast({ title: t('toasts.conflictDismissedTitle'), description: t('toasts.conflictDismissedDesc', { a, b }) })
    } catch (e) {
      reportClientError('Failed to dismiss conflict', e)
      toast({ variant: 'destructive', title: t('toasts.failedToDismissConflictTitle'), description: getUserErrorMessage(e, t('toasts.failedToDismissConflictFallback')) })
    }
  }
  const restorePair = async (a: string, b: string) => {
    if (!canManageMods) return
    try {
      await modsApi.removeIgnoredModPair(a, b)
      setIgnoredPairs(prev => prev.filter(p => {
        const [x, y] = a < b ? [a, b] : [b, a]
        return !(p.mod_a === x && p.mod_b === y)
      }))
    } catch (e) {
      reportClientError('Failed to restore conflict', e)
      toast({ variant: 'destructive', title: t('toasts.failedToRestoreConflictTitle'), description: getUserErrorMessage(e, t('toasts.failedToRestoreConflictFallback')) })
    }
  }

  const toggleAllInGroup = async (g: WsGroup) => {
    if (busyRef.current || !canManageMods || isBridgeGroup(g)) return
    const on = !g.allEnabled
    const modsToToggle = g.mods.filter(mod => mod.enabled !== on)
    if (modsToToggle.length === 0) return
    busyRef.current = true
    try {
      await modsApi.batchToggleModIds(modsToToggle.map(mod => ({ modId: mod.id, enabled: on })))
      setIniConfig(prev => {
        if (!prev) return prev
        let newModIds = [...prev.modIds]
        const newMap = { ...prev.workshopModMap }
        for (const mod of modsToToggle) {
          if (on) {
            if (!newModIds.includes(mod.id)) newModIds.push(mod.id)
          } else {
            newModIds = newModIds.filter(id => id !== mod.id)
          }
        }
        if (newMap[g.wsId]) {
          newMap[g.wsId] = newMap[g.wsId].map(m => {
            const toggled = modsToToggle.find(t => t.id === m.id)
            return toggled ? { ...m, enabled: on } : m
          })
        }
        return { ...prev, modIds: newModIds, totalMods: newModIds.length, workshopModMap: newMap }
      })
      setOrderedModIds(prev => {
        let next = [...prev]
        for (const mod of modsToToggle) {
          if (on) { if (!next.includes(mod.id)) next.push(mod.id) }
          else { next = next.filter(id => id !== mod.id) }
        }
        return next
      })
    } catch (e) { reportClientError('Failed to toggle group', e); toast({ variant: 'destructive', title: t('toasts.failedToToggleGroupTitle'), description: getUserErrorMessage(e, t('toasts.failedToToggleGroupFallback')) }) } finally { busyRef.current = false }
  }

  const removeWorkshop = async (wsId: string, knownModIds?: string[]) => {
    if (!canManageMods) return
    if (isBridgeManagedMod(iniConfig?.bridgeManaged, wsId, knownModIds ?? [])) return
    try {
      await modsApi.removeFromIni(wsId, undefined, knownModIds)
      const updated = await modsApi.getCurrentConfig()
      setIniConfig(updated)
      if (updated?.modIds) syncOrderFromServer(updated.modIds)
      setLastSavedMod(`removed-${wsId}`)
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current)
      savedTimeoutRef.current = setTimeout(() => setLastSavedMod(null), 2000)
    } catch (e) { reportClientError('Failed to remove workshop item', e); toast({ variant: 'destructive', title: t('toasts.failedToRemoveWorkshopItemTitle'), description: getUserErrorMessage(e, t('toasts.failedToRemoveWorkshopItemFallback')) }) }
  }

  // Handle confirmed workshop removal from AlertDialog
  const handleConfirmedRemoveWorkshop = async () => {
    if (confirmRemoveWorkshop) {
      await removeWorkshop(confirmRemoveWorkshop.wsId, confirmRemoveWorkshop.knownModIds)
      setConfirmRemoveWorkshop(null)
    }
  }

  const getGroupLabel = (g: WsGroup): string => {
    const first = g.mods[0]
    return first.name !== first.id ? first.name : first.id
  }

  const getGroupMissingDeps = (g: WsGroup) => Array.from(new Set(g.mods.flatMap(m => activeModsData.missingDepsMap.get(m.id) || [])))

  const getInspectorDepKey = (g: WsGroup, dep: string) => `active-${g.wsId}-${dep}`

  const runInspectorDepSearch = async (g: WsGroup, dep: string, force = false) => {
    if (!canManageMods) return
    const key = getInspectorDepKey(g, dep)
    if (!force && depSearchData[key] && !depSearchData[key].error) return
    setDepSearchData(prev => ({ ...prev, [key]: { loading: true, results: [], error: null, searchUrl: null } }))
    try {
      const res = await modsApi.searchWorkshopMods(dep, {
        parentName: getGroupLabel(g),
        parentWorkshopId: g.wsId,
      })
      setDepSearchData(prev => ({
        ...prev,
        [key]: {
          loading: false,
          results: res.results || [],
          error: null,
          searchUrl: res.searchUrl,
          variantsTried: res.variantsTried,
          steamSearchEnabled: res.steamSearchEnabled,
        }
      }))
    } catch (err: any) {
      setDepSearchData(prev => ({ ...prev, [key]: { loading: false, results: [], error: getUserErrorMessage(err, 'Search failed'), searchUrl: null } }))
    }
  }

  const toggleInspectorDepSearch = (g: WsGroup, dep: string) => {
    const key = getInspectorDepKey(g, dep)
    setDepSearchOpen(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (!depSearchData[key]) runInspectorDepSearch(g, dep)
  }

  const handleInspectorAddDep = async (hit: DepSearchHit, dep: string, key: string) => {
    if (busyRef.current || !canManageMods) return
    busyRef.current = true
    setDepAdding(prev => [...prev, key])
    try {
      await modsApi.addMissingDep(hit.workshopId, hit.modId || dep)
      setDepAddResults(prev => ({ ...prev, [key]: 'added' as const }))
      const updated = await modsApi.getCurrentConfig()
      setIniConfig(updated)
      if (updated?.modIds) syncOrderFromServer(updated.modIds)
      toast({ title: t('toasts.dependencyAddedTitle'), description: t('toasts.dependencyAddedDesc', { name: hit.modName }) })
    } catch (err) {
      reportClientError('Failed to add dependency from inspector.', err)
      setDepAddResults(prev => ({ ...prev, [key]: 'error' as const }))
      toast({ title: t('toasts.addFailedTitle'), description: getUserErrorMessage(err, t('toasts.addFailedFallback')), variant: 'destructive' })
    } finally {
      setDepAdding(prev => prev.filter(item => item !== key))
      busyRef.current = false
    }
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  const selectView = (next: string) => {
    if (!(MODS_VIEWS as readonly string[]).includes(next)) return
    setActiveTab(next as ModsView)
    if (next === 'conflicts' && !conflicts && !conflictsLoading) void scanConflicts()
  }

  // ── Smart sort v2: links and refreshes ─────────────────────────────────────

  // A mod named by the health check: its Workshop item on Active on server.
  const showWorkshopItem = (workshopId: string) => {
    setSelectedActiveWsId(workshopId)
    handleModManagerSearchChange(workshopId)
    selectView('active')
  }
  const showModFromHealth = (modId: string) => {
    const workshopId = modIdWsMap.get(modId)
    if (workshopId) setSelectedActiveWsId(workshopId)
    handleModManagerSearchChange(modId)
    selectView(workshopId ? 'active' : 'order')
  }

  // A fix wrote the server ini: the page takes what was written, and every
  // plan made from the old list is forgotten.
  const afterHealthFix = (result: { applied: boolean }) => {
    if (!result.applied) return
    smart.invalidatePlans()
    void fetchData({ adoptServerOrder: true })
    void smart.insights.reload()
  }

  // A rule stored or deleted: plans change, and the cached scan's
  // suggestions now answer "rule" for the pairs it decides.
  const refreshAfterRuleChange = () => {
    smart.invalidatePlans()
    modsApi.getCachedConflicts()
      .then((cached) => { if (cached && !serverChangedSinceLoad) setConflicts(cached) })
      .catch(() => { /* the suggestions stay as they were */ })
  }

  // "Fix everything" (Conflicts and Health views): one run, one Undo.
  const fixEverythingBlocked = !canManageMods
    ? t('permissions.noModsManage')
    : hasModOrderChanged ? tSmart('health.unsavedOrder') : savingModOrder ? tSmart('health.saving') : null
  const fixEverything = useFixEverything({
    canManage: canManageMods,
    blockedReason: fixEverythingBlocked,
    conflicts,
    conflictsLoading,
    conflictsStale,
    conflictsError,
    scanConflicts: () => { void scanConflicts() },
    groups: activeModsData.groups,
    isPairIgnored,
    modName: (modId) => modIdNameMap.get(modId),
    itemTitle: (workshopId) => trackedByWs.get(workshopId)?.name ?? undefined,
    onChanged: async () => {
      smart.invalidatePlans()
      await Promise.all([fetchData({ adoptServerOrder: true }), smart.rules.reload(), smart.health.reload(), smart.insights.reload()])
    },
  })
  const fixEverythingButton = (
    <FixEverythingButton onClick={fixEverything.openDialog} disabledReason={fixEverythingBlocked} busy={fixEverything.busy} />
  )

  // Workshop items that ship the same mods: one sentence per set of items,
  // the same on the banner, the row badges, the chips and the inspector.
  const modNameOf = useCallback((modId: string) => modIdNameMap.get(modId), [modIdNameMap])
  const itemTitleOf = useCallback((workshopId: string) => trackedByWs.get(workshopId)?.name ?? undefined, [trackedByWs])
  const duplicateText = useHealthText({ modName: modNameOf, itemTitle: itemTitleOf })
  const duplicateSets = useMemo(() => duplicateItemSets(activeModsData.duplicateModIds), [activeModsData])
  const duplicateSentenceOf = (modId: string) => {
    const set = duplicateSets.find((s) => s.modIds.includes(modId))
    if (!set) return ''
    const titles = keepFixesFor(smart.health.health, set)?.issue.params.titles
    return duplicateText.duplicateSentence(set.workshopIds, set.modIds, titles && typeof titles === 'object' ? (titles as Record<string, unknown>) : {})
  }
  const duplicateNotice = (set: DuplicateItemSet) => (
    <DuplicateItemsNotice
      key={set.key}
      set={set}
      store={smart.health}
      canManage={canManageMods}
      blockedReason={hasModOrderChanged ? tSmart('health.unsavedOrder') : savingModOrder ? tSmart('health.saving') : null}
      modName={modNameOf}
      itemTitle={itemTitleOf}
      onFixed={afterHealthFix}
    />
  )

  // The inspector's "Add" for a missing Steam required item: the health
  // check's own fix when it has one.
  const applyHealthFixFromInspector = async (issue: ModHealthIssue, fix: ModHealthFix) => {
    try {
      const result = await smart.health.applyFix(issue, fix)
      afterHealthFix(result)
      toast({ title: tSmart('item.addedTitle') })
    } catch (error) {
      toast({ title: tSmart('item.addFailedTitle'), description: getUserErrorMessage(error, tSmart('item.addFailedFallback')), variant: 'destructive' })
    }
  }
  const openAddDialogFor = (workshopId: string) => {
    setAdvancedAddDialogOpen(true)
    // As a Workshop link, so the dialog looks the item up at once.
    handleModInputChange(`https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`)
  }

  // The "downloaded, not on the server" section scans the Workshop folder the
  // first time the Deactivated view opens (and again from its Refresh).
  const diskScanRequestedRef = useRef(false)
  useEffect(() => {
    if (activeTab !== 'deactivated' || permissionDenied || diskScanRequestedRef.current || disabledScanned) return
    diskScanRequestedRef.current = true
    void fetchDisabled()
  }, [activeTab, permissionDenied, disabledScanned, fetchDisabled])
  useEffect(() => {
    if (!disabledScanned) diskScanRequestedRef.current = false
  }, [disabledScanned])

  const navGroups: SubNavGroup[] = NAV_GROUPS.map((group) => ({
    id: group.id,
    label: t(group.labelKey),
    items: group.views.map((view) => {
      const count =
        view === 'deactivated' ? deactivatedMods.length
        : view === 'installed' ? installedModsWithUpdates.length
        : 0
      const healthCounts = smart.health.health?.counts
      const healthCount = view === 'health' && healthCounts ? (healthCounts.critical > 0 ? healthCounts.critical : healthCounts.warning) : 0
      return {
        id: view,
        label: view === 'health' ? tSmart('nav.health') : t(`nav.${view}.label`),
        icon: VIEW_ICONS[view],
        dirty: view === 'order' && hasModOrderChanged,
        badge: healthCount > 0 && healthCounts ? (
          <span
            className={cn(
              'rounded-full px-1.5 text-[10px] font-medium tabular-nums',
              healthCounts.critical > 0 ? 'bg-destructive/20 text-foreground' : 'bg-warning/15 text-foreground',
            )}
            title={healthCounts.critical > 0 ? tSmart('nav.healthCritical', { count: healthCount }) : tSmart('nav.healthWarning', { count: healthCount })}
          >
            {healthCount}
          </span>
        ) : count > 0 ? (
          <span
            className={cn(
              'rounded-full px-1.5 text-[10px] font-medium tabular-nums',
              view === 'installed' ? 'bg-warning/15 text-foreground' : 'bg-muted text-muted-foreground',
            )}
            title={view === 'installed' ? t('statusBar.updatesCount', { count }) : undefined}
          >
            {count}
          </span>
        ) : undefined,
      }
    }),
  }))
  const currentView = NAV_GROUPS.flatMap((group) => group.views).includes(activeTab) ? activeTab : 'installed'

  // ── Page alerts (after the header, errors first) ───────────────────────────
  const pageAlerts: PageAlert[] = []
  if (fetchError) {
    pageAlerts.push({
      id: 'fetch-error',
      tone: 'error',
      title: t('fetchError.title'),
      description: <span className="break-words" dir="auto">{fetchError}</span>,
      action: { label: t('fetchError.retry'), onClick: () => void fetchData({ manual: true }) },
    })
  }
  if (status?.pendingRestart) {
    pageAlerts.push({
      id: 'restart-pending',
      tone: 'warning',
      title: t('restartPending.title'),
      description: canManageMods
        ? t('restartPending.waiting', { minutes: status.maxDelayMinutes })
        : `${t('restartPending.waiting', { minutes: status.maxDelayMinutes })} ${t('permissions.noModsManage')}`,
      action: canManageMods ? { label: t('restartPending.cancelAria'), onClick: () => void handleCancelPendingRestart() } : undefined,
    })
  }
  // Stale-flag warning: Steam reports N pending updates from the live Workshop
  // ACF but the per-mod DB flags don't reflect them yet (e.g. last check was
  // rejected, or the ACF was rewritten by Steam after a sync).
  if (!status?.pendingRestart && (status?.updatesAvailable ?? 0) > 0 && groupedMods.updateAvailable.length === 0 && !checking && modsWithUpdates.length === 0) {
    pageAlerts.push({
      id: 'stale-flags',
      tone: 'warning',
      title: t('staleFlag.reported', { count: status?.updatesAvailable }),
      description: t('staleFlag.desc'),
      action: canManageMods ? { label: t('staleFlag.checkNow'), onClick: () => void handleCheckUpdates() } : undefined,
    })
  }
  // Mods Steam confirmed no longer exist on the Workshop (EResult 9). Needs
  // the operator to act: the item never comes back and keeps breaking update
  // checks and restarts until removed.
  if (removedWorkshopMods.length > 0) {
    pageAlerts.push({
      id: 'removed-from-workshop',
      tone: 'warning',
      title: t('removedFromWorkshop.title', { count: removedWorkshopMods.length }),
      description: (
        <div className="space-y-2">
          <p>{t('removedFromWorkshop.desc')}</p>
          <div className="flex flex-wrap gap-1.5">
            {removedWorkshopMods.map((m) => (
              <span key={m.workshopId} className="inline-flex items-center gap-1 rounded-md border border-warning/30 bg-background/60 py-1 ps-2 pe-1 text-xs text-foreground">
                <span className="max-w-[16rem] truncate" title={m.name || m.workshopId}>
                  {m.name || m.workshopId}
                </span>
                <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                  <button
                    type="button"
                    onClick={() => setConfirmRemoveMod({ wsId: m.workshopId, label: m.name || m.workshopId })}
                    disabled={loading || !canManageMods}
                    aria-label={t('removedFromWorkshop.removeAria', { name: m.name || m.workshopId })}
                    className="grid h-7 w-7 place-items-center rounded text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </DisabledReason>
              </span>
            ))}
          </div>
        </div>
      ),
    })
  }
  // A setting written twice in the raw INI: this page reads the first copy,
  // the Server Configuration editor the last (server/utils/iniDuplicateKeys.js).
  if (iniConfig?.duplicateKeys && iniConfig.duplicateKeys.length > 0) {
    pageAlerts.push({
      id: 'duplicate-keys',
      tone: 'warning',
      title: t('duplicateKeysWarning.title', {
        count: iniConfig.duplicateKeys.length,
        keys: iniConfig.duplicateKeys.map(d => d.key).join(', '),
      }),
      description: t('duplicateKeysWarning.desc'),
    })
  }
  // Steam Workshop unreachable this cycle: quiet, needs nothing (checks fall
  // back to local files and retry on their own). Dismissed per failure stamp,
  // so the next failed cycle shows it again.
  if (status && !status.steamApiHealthy && status.lastSteamApiFailureAt && steamApiIssueDismissed !== status.lastSteamApiFailureAt) {
    const since = status.lastSteamApiFailureAt
    pageAlerts.push({
      id: 'steam-api',
      tone: 'info',
      title: t('steamApiIssue.label'),
      onDismiss: () => {
        try {
          localStorage.setItem(STEAM_API_ISSUE_DISMISSED_KEY, since)
        } catch {
          /* ignore storage failures */
        }
        setSteamApiIssueDismissed(since)
      },
    })
  }
  // The third Steam state: an EResult other than found or removed. Shows the
  // raw code, never an invented explanation.
  if ((status?.unknownWorkshopIds?.length ?? 0) > 0) {
    pageAlerts.push({
      id: 'unknown-workshop-result',
      tone: 'info',
      title: t('unknownWorkshopResult.label', { count: status!.unknownWorkshopIds.length }),
      description: status!.unknownWorkshopIds.map((item) => t('unknownWorkshopResult.item', { id: item.id, code: item.resultCode })).join(', '),
    })
  }

  // ── Filters shown as removable chips ───────────────────────────────────────
  const groupFilterLabel = (filter: GroupFilter) =>
    filter.kind === 'ungrouped'
      ? t('filters.ungrouped')
      : filter.kind === 'group'
        ? t('filters.inGroup', { name: groupsStore.groupsById.get(filter.groupId)?.name ?? '' })
        : ''

  const installedChips: Array<{ key: string; label: string; onRemove: () => void }> = [
    ...(showUpdatesOnly ? [{ key: 'updates', label: t('filters.updatesOnly'), onRemove: () => setShowUpdatesOnly(false) }] : []),
    ...(installedFilters.hasNote ? [{ key: 'note', label: t('filters.hasNote'), onRemove: () => setInstalledFilters((f) => ({ ...f, hasNote: false })) }] : []),
    ...(installedGroupFilter.kind !== 'all' ? [{ key: 'group', label: groupFilterLabel(installedGroupFilter), onRemove: () => setInstalledFilters((f) => ({ ...f, group: ALL_GROUPS })) }] : []),
  ]
  const clearInstalledFilters = () => {
    setShowUpdatesOnly(false)
    setInstalledFilters({ hasNote: false, group: ALL_GROUPS })
  }

  const activeChips: Array<{ key: string; label: string; onRemove: () => void }> = [
    ...(multiIdFilterOn ? [{ key: 'multi', label: t('filters.multiId'), onRemove: () => setFilterMultiId(false) }] : []),
    ...(filterAttention ? [{ key: 'attention', label: t('filters.needsAttention'), onRemove: () => setFilterAttention(false) }] : []),
    ...(filterNotEnabled ? [{ key: 'notEnabled', label: t('filters.notEnabled'), onRemove: () => setFilterNotEnabled(false) }] : []),
    ...(activeFilters.updates ? [{ key: 'updates', label: t('filters.updates'), onRemove: () => setActiveFilters((f) => ({ ...f, updates: false })) }] : []),
    ...(activeFilters.missingDep ? [{ key: 'missingDep', label: t('filters.missingDep'), onRemove: () => setActiveFilters((f) => ({ ...f, missingDep: false })) }] : []),
    ...(activeFilters.hasNote ? [{ key: 'note', label: t('filters.hasNote'), onRemove: () => setActiveFilters((f) => ({ ...f, hasNote: false })) }] : []),
    ...(activeGroupFilter.kind !== 'all' ? [{ key: 'group', label: groupFilterLabel(activeGroupFilter), onRemove: () => setActiveFilters((f) => ({ ...f, group: ALL_GROUPS })) }] : []),
    ...(activeKind ? [{ key: 'kind', label: tSmart('filter.chip', { kind: tSmart(`kind.${activeKind}`) }), onRemove: () => setActiveKind('all') }] : []),
  ]
  const clearActiveFilters = () => {
    setFilterMultiId(false)
    setFilterAttention(false)
    setFilterNotEnabled(false)
    setActiveKind('all')
    setActiveFilters({ updates: false, missingDep: false, hasNote: false, group: ALL_GROUPS })
  }

  const renderFilterChips = (chips: Array<{ key: string; label: string; onRemove: () => void }>, onClear: () => void) =>
    chips.length > 0 ? (
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('filters.activeAria')}>
        <span className="text-xs text-muted-foreground">{t('filters.filteredBy')}</span>
        {chips.map((chip) => (
          <span key={chip.key} className="inline-flex h-7 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 ps-2.5 pe-0.5 text-xs text-foreground">
            {chip.label}
            <button
              type="button"
              onClick={chip.onRemove}
              aria-label={t('filters.removeAria', { name: chip.label })}
              className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground hover:bg-primary/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        {chips.length > 1 && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            {t('filters.clearAll')}
          </Button>
        )}
      </div>
    ) : null

  // The group filter as one Select: every group, "In no group", or one group.
  const renderGroupFilter = (filter: GroupFilter, onChange: (next: GroupFilter) => void) => (
    <Select
      value={filter.kind === 'group' ? `g:${filter.groupId}` : filter.kind}
      onValueChange={(value) => onChange(value === 'all' ? ALL_GROUPS : value === 'ungrouped' ? { kind: 'ungrouped' } : { kind: 'group', groupId: value.slice(2) })}
    >
      <SelectTrigger className="h-11 w-auto min-w-[9rem] gap-2 text-xs sm:h-8" aria-label={t('filters.groupAria')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t('filters.allGroups')}</SelectItem>
        <SelectItem value="ungrouped">{t('filters.ungrouped')}</SelectItem>
        {groupsStore.groups.map((group) => (
          <SelectItem key={group.id} value={`g:${group.id}`}>{group.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const filterChipClass = (pressed: boolean) =>
    cn(
      'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 sm:h-8',
      pressed ? 'border-primary/50 bg-primary/15 text-foreground' : 'border-border/60 text-muted-foreground hover:bg-accent/30 hover:text-foreground',
    )

  // Selected rows' mod IDs (Installed ticks are Workshop items).
  const installedSelectionModIds = [...selectedMods].flatMap((wsId) => wsModIds.get(wsId) ?? [])
  const activeSelectionModIds = [...selectedActiveWs].flatMap((wsId) => wsModIds.get(wsId) ?? [])
  const orderSelectionModIds = orderedModIds.filter((id, i) => selectedOrderIds.has(id) && orderedModIds.indexOf(id) === i)

  const lastCheckText = status?.lastCheck
    ? (() => {
        const secs = Math.round((Date.now() - new Date(status.lastCheck).getTime()) / 1000)
        let when: string
        if (secs < 60) when = t('statusBar.lastCheckedAgo', { when: t('statusBar.secondsAgo', { count: secs }) })
        else if (secs < 3600) when = t('statusBar.lastCheckedAgo', { when: t('statusBar.minutesAgo', { count: Math.floor(secs / 60) }) })
        else if (secs < 86400) when = t('statusBar.lastCheckedAgo', { when: t('statusBar.hoursAgo', { count: Math.floor(secs / 3600) }) })
        else when = formatDate(status.lastCheck)
        return t('statusBar.lastCheckedOn', { when })
      })()
    : t('statusBar.neverChecked')

  const renderInstalledRows = () => {
    if (installedMode === 'groups') {
      return (
        <GroupSections
          items={filteredMods.map((mod) => ({ key: mod.workshop_id, modIds: wsModIds.get(mod.workshop_id) ?? [], mod }))}
          renderItem={(item) => renderModRow(item.mod)}
          groups={groupsStore.groups}
          enabledModIds={enabledModIds}
          availableModIds={availableModIds}
          modNames={modIdNameMap}
          conflictsByGroup={conflictsByGroup}
          onShowConflicts={showGroupConflicts}
          canManage={canManageMods}
          busyGroupId={busyGroupId}
          onEnable={(group) => void handleEnableGroup(group)}
          onDisable={(group) => void handleDisableGroup(group)}
          onEdit={(group) => setGroupEditor({ group })}
          applyOrder={{ run: () => void applyGroupOrder(), reason: applyOrderReason }}
          hideEmptyGroups={!!deferredSearchQuery || installedChips.length > 0}
          storageKey="zcp:mods:installed:collapsedGroups"
          className="h-[calc(100vh-340px)] min-h-[300px]"
        />
      )
    }
    return (
      <div ref={modListRef} className="h-[calc(100vh-340px)] min-h-[300px] overflow-y-auto">
        <div style={{ height: modListVirtualizer.getTotalSize(), position: 'relative' }}>
          {modListVirtualizer.getVirtualItems().map(virtualRow => {
            const item = flatModItems[virtualRow.index]
            return (
              <div
                key={virtualRow.key}
                // Measured, not estimated: a row wraps taller on a phone
                // (badges, "What changed", group dots) and must not overlap the next.
                data-index={virtualRow.index}
                ref={modListVirtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {item.type === 'header' && item.group === 'update' && (
                  <div className="flex items-center gap-2.5 border-b border-warning/25 bg-warning/10 px-4 py-2.5">
                    <span className="relative inline-flex shrink-0" aria-hidden="true">
                      <span className="absolute inset-0 animate-ping rounded-full bg-warning/40" />
                      <span className="relative h-2 w-2 rounded-full bg-warning" />
                    </span>
                    <span className="text-sm font-semibold text-foreground">
                      {t('installedTab.updatesAvailable')}
                    </span>
                    <span className="inline-flex h-5 items-center rounded-full bg-warning/20 px-2 text-xs tabular-nums text-foreground">
                      {item.count}
                    </span>
                  </div>
                )}
                {item.type === 'header' && item.group === 'neverChecked' && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 border-b border-border/40 bg-muted/20 px-4 py-2 text-start transition-colors hover:bg-muted/30"
                    onClick={() => setNeverCheckedExpanded(!neverCheckedExpanded)}
                    aria-expanded={neverCheckedExpanded}
                  >
                    <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform rtl:-scale-x-100 ${neverCheckedExpanded ? 'rotate-90 rtl:-rotate-90' : ''}`} />
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-muted-foreground">
                      {t('installedTab.neverCheckedHeader')}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {item.count}
                    </span>
                    {!neverCheckedExpanded && (
                      <span className="ms-auto hidden text-xs text-muted-foreground sm:inline">
                        {t('installedTab.expandHint')} <kbd className="rounded border border-border/60 bg-muted/40 px-1 py-0 text-micro">{t('installedTab.checkUpdatesKbd')}</kbd>
                      </span>
                    )}
                  </button>
                )}
                {item.type === 'header' && item.group === 'upToDate' && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 border-b border-border/40 bg-primary/5 px-4 py-2 text-start transition-colors hover:bg-primary/10"
                    onClick={() => setUpToDateExpanded(!upToDateExpanded)}
                    aria-expanded={upToDateExpanded}
                  >
                    <ChevronRight className={`h-4 w-4 text-primary transition-transform rtl:-scale-x-100 ${upToDateExpanded ? 'rotate-90 rtl:-rotate-90' : ''}`} />
                    <CheckCircle className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium text-foreground">
                      {t('installedTab.upToDate')}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {item.count}
                    </span>
                  </button>
                )}
                {item.type === 'hint' && (
                  <div className="flex items-center gap-3 border-b border-border/40 bg-primary/5 px-4 py-3">
                    <RefreshCw className="h-4 w-4 shrink-0 text-primary" />
                    <p className="text-sm text-muted-foreground">
                      <Trans i18nKey="installedTab.hintText" t={t} components={{ 1: <strong className="text-foreground" /> }} />
                    </p>
                  </div>
                )}
                {item.type === 'mod' && (
                  <div className="border-b border-border/30">
                    {renderModRow(item.mod)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <TooltipProvider>
      <div className="space-y-6 page-transition">
        <PageHeader
          title={t('pageHeader.title')}
          description={t('pageHeader.description')}
          actions={
            <Button onClick={() => setAdvancedAddOpen(true)} size="sm" variant="command">
              <Plus aria-hidden="true" />
              {t('pageHeader.addMod')}
            </Button>
          }
        />

        {permissionDenied ? (
          <EmptyState
            type="accessDenied"
            icon={<ShieldAlert className="h-14 w-14 text-muted-foreground/40" />}
            title={t('permissionDenied.title')}
            description={t('permissionDenied.description')}
          />
        ) : (
        <>
        <PageAlerts alerts={pageAlerts} />

        {/* Status bar: always shown, even with nothing tracked yet. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border/60 bg-card px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
              <Package className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {/* The Installed list's mods: a Deactivated item is tracked, not on the server. */}
              {t('statusBar.onServer', { count: iniConfig === null ? (status?.totalModsTracked || 0) : installedMods.length })}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex cursor-help items-center gap-1.5 font-medium text-foreground" tabIndex={0}>
                  <Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  {t('statusBar.inConfig', { count: iniConfig?.workshopIds?.length || 0 })}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('statusBar.workshopItemsTooltip', { count: iniConfig?.workshopIds?.length || 0 })}</p>
                <p className="text-muted-foreground">{t('statusBar.modIdsTooltip', { count: iniConfig?.totalMods || 0 })}</p>
              </TooltipContent>
            </Tooltip>
            {installedModsWithUpdates.length > 0 && (
              <button
                type="button"
                onClick={() => { selectView('installed'); setShowUpdatesOnly(true) }}
                className="inline-flex items-center gap-1.5 rounded font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              >
                <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
                {t('statusBar.updatesCount', { count: installedModsWithUpdates.length })}
              </button>
            )}
            {status && (
              <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                <button
                  type="button"
                  onClick={() => { if (!canManageMods) return; setRestartSettingsOpen(true) }}
                  disabled={!canManageMods}
                  className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-not-allowed"
                  aria-label={t(status.autoRestartEnabled ? 'statusBar.autoRestartOnAria' : 'statusBar.autoRestartOffAria')}
                >
                  <StatusPill
                    size="sm"
                    tone={status.autoRestartEnabled ? 'ok' : 'idle'}
                    label={t(status.autoRestartEnabled ? 'statusBar.autoRestartOn' : 'statusBar.autoRestartOff')}
                    className="transition-colors hover:bg-accent/40"
                  />
                </button>
              </DisabledReason>
            )}
            {/* No Workshop ACF file is NOT necessarily broken: it is the
                normal, permanent state of a non-Steam/GOG install (GitHub
                #148), indistinguishable from a SteamCMD install that has not
                downloaded a Workshop mod yet. Neutral on purpose; "Fix path"
                stays for the operator whose path really is wrong. */}
            {status && !status.workshopAcfConfigured && (
              <span className="inline-flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground" role="status">
                <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="text-xs">{t('statusBar.workshopPathMissing')}</span>
                <DisabledReason reason={!canManageServers ? t('permissions.noServersManage') : null}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOpenWorkshopBrowser}
                    disabled={savingWorkshopPath || !canManageServers}
                  >
                    <FolderOpen aria-hidden="true" />
                    {t('statusBar.fixPath')}
                  </Button>
                </DisabledReason>
              </span>
            )}
          </div>

          <div className="ms-auto flex items-center gap-2">
            {/* A disabled Button never fires the pointer events its own
                Tooltip needs, so the permission reason lives in
                DisabledReason's wrapper; enabled, the hint Tooltip works as
                before. */}
            <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" onClick={handleSyncFromServer} disabled={loading || !canManageMods}>
                    <Download aria-hidden="true" />
                    {t('statusBar.sync')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('statusBar.syncTooltip')}</TooltipContent>
              </Tooltip>
            </DisabledReason>
            <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" onClick={handleCheckUpdates} disabled={checking || !canManageMods}>
                    <RefreshCw className={checking ? 'animate-spin' : undefined} aria-hidden="true" />
                    {t('statusBar.checkUpdates')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs space-y-1">
                  <p>{t('statusBar.checkUpdatesTooltip')}</p>
                  <p className="text-muted-foreground">{lastCheckText}</p>
                </TooltipContent>
              </Tooltip>
            </DisabledReason>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="iconDense" aria-label={t('statusBar.moreActionsAria')} title={t('statusBar.moreActionsAria')}>
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null} className="w-full">
                  <DropdownMenuItem
                    onClick={() => {
                      if (!canManageMods) return
                      selectView('collection')
                      setCollectionDialogOpen(true)
                    }}
                    disabled={!canManageMods}
                  >
                    <Library className="me-2 h-4 w-4" />
                    {t('statusBar.importCollection')}
                  </DropdownMenuItem>
                </DisabledReason>
                <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null} className="w-full">
                  <DropdownMenuItem
                    onClick={() => { if (!canManageMods) return; setRestartSettingsOpen(true) }}
                    disabled={!canManageMods}
                  >
                    <Settings2 className="me-2 h-4 w-4" />
                    {t('statusBar.autoRestartSettings')}
                  </DropdownMenuItem>
                </DisabledReason>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <SubNavLayout
          nav={<SubNav kind="nav" groups={navGroups} value={currentView} onValueChange={selectView} ariaLabel={t('nav.aria')} />}
        >
          {/* Installed: every Workshop item the panel tracks for updates, on the server. */}
          {activeTab === 'installed' && (
            <SectionCard
              title={t('nav.installed.label')}
              description={t('nav.installed.hint')}
              icon={Package}
              flush
              actions={
                <Segmented<ListMode>
                  value={installedMode}
                  onValueChange={setInstalledMode}
                  ariaLabel={t('listMode.aria')}
                  items={[
                    { value: 'list', label: t('listMode.list') },
                    { value: 'groups', label: t('listMode.groups') },
                  ]}
                />
              }
            >
              {(mods.length > 0 || installedChips.length > 0 || searchQuery) && (
                <div className="space-y-2 border-b border-border/60 p-4">
                  <Toolbar
                    search={{
                      value: searchQuery,
                      onChange: handleSearchChange,
                      placeholder: t('installedTab.searchPlaceholder'),
                      ariaLabel: t('installedTab.searchAria'),
                      slashToFocus: true,
                    }}
                    end={
                      <>
                        {/* Workshop collection sync indicator: only when a
                            collection ID is wired up. The chip refreshes the
                            diff; the inline button runs the sync. */}
                        {collectionStatus.configured && (
                          collectionStatus.error ? (
                            <button
                              type="button"
                              onClick={fetchCollectionStatus}
                              title={t('installedTab.collectionErrorTitle', { error: collectionStatus.error })}
                              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-destructive/20"
                            >
                              <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                              {t('installedTab.collectionError')}
                            </button>
                          ) : collectionStatus.inSync ? (
                            <button
                              type="button"
                              onClick={fetchCollectionStatus}
                              title={collectionStatus.title ? t('installedTab.collectionInSyncTitleNamed', { title: collectionStatus.title }) : t('installedTab.collectionInSyncTitle')}
                              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-success/40 bg-success/10 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-success/20"
                            >
                              <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                              {t('installedTab.collectionInSync')}
                              {collectionStatus.autoSync && <span className="text-muted-foreground">{t('installedTab.collectionAutoTag')}</span>}
                            </button>
                          ) : collectionStatus.drift > 0 ? (
                            <div className="inline-flex h-8 items-center gap-1 rounded-md border border-warning/40 bg-warning/10 pe-1 ps-2.5 text-xs font-medium text-foreground">
                              <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
                              <span>{t('installedTab.collectionDrift', { count: collectionStatus.drift })}</span>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={handleCollectionSyncNow}
                                disabled={collectionSyncing || !canManageMods}
                                className="ms-1 h-6 px-2 text-xs hover:bg-warning/20 sm:h-6"
                                // The status bar has a "Sync" too (from the server INI): this one names the collection.
                                aria-label={t('installedTab.collectionSyncAria')}
                                // eslint-disable-next-line local/no-dead-disabled-title -- pure hint describing what the button does ("Sync tracked mods → Steam Workshop collection"), not why it's disabled; unconditional, no permission text to lose. Triaged 2026-08-27.
                                title={t('installedTab.collectionSyncTooltip')}
                              >
                                {collectionSyncing ? <Loader2 className="h-3 w-3 animate-spin" /> : t('installedTab.collectionSync')}
                              </Button>
                            </div>
                          ) : collectionStatus.loading ? (
                            <span className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 text-xs text-muted-foreground">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                              {t('installedTab.collectionChecking')}
                            </span>
                          ) : null
                        )}
                      </>
                    }
                  >
                    <button
                      type="button"
                      onClick={() => setShowUpdatesOnly(!showUpdatesOnly)}
                      aria-pressed={showUpdatesOnly}
                      className={filterChipClass(showUpdatesOnly)}
                    >
                      {showUpdatesOnly ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Filter className="h-3.5 w-3.5" aria-hidden="true" />}
                      {t('installedTab.updatesOnly')}
                      {installedModsWithUpdates.length > 0 && <span className="tabular-nums text-muted-foreground">{installedModsWithUpdates.length}</span>}
                    </button>
                    <button
                      type="button"
                      onClick={() => setInstalledFilters((f) => ({ ...f, hasNote: !f.hasNote }))}
                      aria-pressed={installedFilters.hasNote}
                      className={filterChipClass(installedFilters.hasNote)}
                    >
                      <StickyNote className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('filters.hasNote')}
                    </button>
                    {groupsStore.groups.length > 0 && renderGroupFilter(installedGroupFilter, (group) => setInstalledFilters((f) => ({ ...f, group })))}
                    <Select value={installedSort} onValueChange={(value) => setInstalledSort(INSTALLED_SORTS.includes(value as InstalledSort) ? (value as InstalledSort) : 'status')}>
                      <SelectTrigger className="h-11 w-auto min-w-[9rem] gap-2 text-xs sm:h-8" aria-label={t('sort.aria')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="status">{t('sort.status')}</SelectItem>
                        <SelectItem value="name">{t('sort.name')}</SelectItem>
                        <SelectItem value="updated">{t('sort.updated')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Toolbar>
                  {renderFilterChips(installedChips, clearInstalledFilters)}
                  <div className="flex flex-wrap items-center gap-2">
                    {selectedMods.size > 0 ? (
                      <div className="bulk-bar-enter flex w-full flex-wrap items-center gap-2 sm:w-auto" role="group" aria-label={t('installedTab.selectionAria')}>
                        <span className="text-sm text-muted-foreground">
                          {t('installedTab.selectedCount', { count: selectedMods.size })}
                        </span>
                        <Button variant="outline" size="sm" onClick={deselectAll}>
                          {t('installedTab.deselect')}
                        </Button>
                        <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : installedSelectionModIds.length === 0 ? tGroups('addTo.noModIds') : null}>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setAddToGroup({ modIds: installedSelectionModIds, clearSelection: 'installed' })}
                            disabled={!canManageMods || installedSelectionModIds.length === 0}
                          >
                            <FolderPlus aria-hidden="true" />
                            {tGroups('addTo.selected')}
                          </Button>
                        </DisabledReason>
                        <Button variant="destructive" size="sm" onClick={() => setConfirmBulkRemove(true)} disabled={loading || !canManageMods}>
                          <Trash2 aria-hidden="true" />
                          {t('installedTab.remove')}
                        </Button>
                      </div>
                    ) : visibleServerMods.length > 0 ? (
                      <Button variant="ghost" size="sm" onClick={selectAllVisible}>
                        {t('installedTab.selectAll', { count: visibleServerMods.length })}
                      </Button>
                    ) : null}
                  </div>
                </div>
              )}

              {initialLoading && mods.length === 0 ? (
                <div className="space-y-3 p-4" role="status" aria-label={t('installedTab.loading')}>
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-16 w-16 rounded-md" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-1/2" />
                        <Skeleton className="h-3 w-1/3" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : filteredMods.length === 0 ? (
                searchQuery || installedChips.length > 0 ? (
                  <div className="p-6">
                    <EmptyState
                      type="noResults"
                      compact
                      title={t('installedTab.noResultsTitle')}
                      description={t('installedTab.noResultsDesc')}
                      action={{
                        label: searchQuery ? t('installedTab.clearSearch') : t('filters.clearAll'),
                        onClick: () => { handleSearchChange(''); clearInstalledFilters() },
                        variant: 'outline',
                      }}
                    />
                  </div>
                ) : mods.length > 0 ? (
                  <div className="p-6">
                    <EmptyState
                      type="noData"
                      compact
                      title={t('installedTab.allDeactivatedTitle')}
                      description={t('installedTab.allDeactivatedDesc', { count: deactivatedMods.length })}
                      action={{ label: t('nav.deactivated.label'), onClick: () => selectView('deactivated'), variant: 'outline' }}
                    />
                  </div>
                ) : (
                  <div className="px-4 py-10 sm:px-8">
                    <div className="mx-auto max-w-2xl">
                      <div className="mb-6 flex flex-col items-center text-center">
                        <div className="mb-4 grid h-14 w-14 place-items-center rounded-xl border border-primary/25 bg-primary/10" aria-hidden="true">
                          <Package className="h-7 w-7 text-primary" />
                        </div>
                        <h3 className="text-base font-semibold text-foreground">{t('installedTab.emptyTitle')}</h3>
                        <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
                          {t('installedTab.emptyDesc')}
                        </p>
                      </div>

                      {/* Three ways to fill the list. */}
                      <div className="mb-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
                        {/* First-time operators land here with an empty list,
                            and this "Recommended" tile is the button they try
                            first: without mods.manage it says why it is off. */}
                        <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null} className="w-full">
                          <button
                            type="button"
                            onClick={handleSyncFromServer}
                            disabled={loading || !canManageMods}
                            className="group w-full rounded-lg border border-border/60 bg-muted/20 px-3 py-3 text-start transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <div className="mb-1.5 flex items-center gap-2">
                              <RefreshCw className="h-4 w-4 text-primary" aria-hidden="true" />
                              <span className="text-sm font-semibold text-foreground">{t('installedTab.syncFromServerTitle')}</span>
                            </div>
                            <p className="text-xs leading-snug text-muted-foreground">
                              {t('installedTab.syncFromServerDesc')}
                            </p>
                            <p className="label-micro mt-1.5 text-primary">{t('installedTab.recommended')}</p>
                          </button>
                        </DisabledReason>

                        <button
                          type="button"
                          onClick={() => { selectView('collection'); setCollectionDialogOpen(true) }}
                          disabled={loading}
                          className="group rounded-lg border border-border/60 bg-muted/20 px-3 py-3 text-start transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <div className="mb-1.5 flex items-center gap-2">
                            <Library className="h-4 w-4 text-primary" aria-hidden="true" />
                            <span className="text-sm font-semibold text-foreground">{t('installedTab.importCollectionTitle')}</span>
                          </div>
                          <p className="text-xs leading-snug text-muted-foreground">
                            {t('installedTab.importCollectionDesc')}
                          </p>
                        </button>

                        <button
                          type="button"
                          onClick={() => setAdvancedAddOpen(true)}
                          disabled={loading}
                          className="group rounded-lg border border-border/60 bg-muted/20 px-3 py-3 text-start transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <div className="mb-1.5 flex items-center gap-2">
                            <PlusCircle className="h-4 w-4 text-primary" aria-hidden="true" />
                            <span className="text-sm font-semibold text-foreground">{t('installedTab.addSingleModTitle')}</span>
                          </div>
                          <p className="text-xs leading-snug text-muted-foreground">
                            {t('installedTab.addSingleModDesc')}
                          </p>
                        </button>
                      </div>

                      <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
                        <Info className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('installedTab.trackingMetadataOnly')}
                      </p>
                    </div>
                  </div>
                )
              ) : (
                renderInstalledRows()
              )}
            </SectionCard>
          )}

          {/* Deactivated: tracked items no longer in WorkshopItems=, Workshop
              folders the server does not load, and the ignore list. */}
          {activeTab === 'deactivated' && (
            <>
              <SectionCard
                title={t('deactivatedTab.title')}
                description={<Trans i18nKey="deactivatedTab.description" t={t} components={{ 1: <code className="font-mono text-xs" /> }} />}
                icon={EyeOff}
                status={<Badge variant="outline" className="tabular-nums">{deactivatedMods.length}</Badge>}
                flush
              >
                {!iniConfig ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    {t('deactivatedTab.loadingConfig')}
                  </div>
                ) : deactivatedMods.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
                    <CheckCircle className="h-8 w-8 text-muted-foreground/40" aria-hidden="true" />
                    <p className="text-sm text-muted-foreground">
                      {t('deactivatedTab.emptyTitle')}
                    </p>
                    <p className="max-w-md text-xs text-muted-foreground">
                      {t('deactivatedTab.emptyDesc')}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="border-b border-border/40 px-4 py-2.5">
                      <Toolbar
                        search={{
                          value: searchQuery,
                          onChange: handleSearchChange,
                          placeholder: t('installedTab.searchPlaceholder'),
                          ariaLabel: t('installedTab.searchAria'),
                          slashToFocus: true,
                        }}
                      />
                    </div>
                    {/* Toolbar: select-all / enable / delete bulk actions */}
                    {(() => {
                      const deactivatedIds = shownDeactivated.map(m => m.workshop_id)
                      const selectedDeactivated = deactivatedIds.filter(id => selectedMods.has(id))
                      const allSelected = selectedDeactivated.length === deactivatedIds.length && deactivatedIds.length > 0
                      const someSelected = selectedDeactivated.length > 0
                      const missingNameCount = deactivatedMods.filter(m => !m.name || /^Workshop Mod /i.test(m.name)).length
                      return (
                        <div className="space-y-2 border-b border-border/40 bg-muted/15 px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="flex items-center gap-2">
                              <Checkbox
                                checked={allSelected}
                                onCheckedChange={(checked) => {
                                  setSelectedMods(prev => {
                                    const next = new Set(prev)
                                    if (checked) {
                                      for (const id of deactivatedIds) next.add(id)
                                    } else {
                                      for (const id of deactivatedIds) next.delete(id)
                                    }
                                    return next
                                  })
                                }}
                                aria-label={t('deactivatedTab.selectAllAria')}
                              />
                              <span className="text-xs text-muted-foreground">
                                {someSelected ? t('deactivatedTab.selectedCount', { count: selectedDeactivated.length }) : t('deactivatedTab.selectAllCount', { count: deactivatedIds.length })}
                              </span>
                            </div>
                            <div className="ms-auto flex items-center gap-2">
                              <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={!someSelected || loading || !canManageMods}
                                  onClick={() => handleBulkEnable(selectedDeactivated)}
                                >
                                  <PlusCircle aria-hidden="true" />
                                  {someSelected ? t('deactivatedTab.reEnableCount', { count: selectedDeactivated.length }) : t('deactivatedTab.reEnable')}
                                </Button>
                              </DisabledReason>
                            </div>
                          </div>
                          <details className="group/deactivated-danger rounded-md border border-border/50 bg-card px-2.5 py-1.5">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs text-muted-foreground hover:text-foreground">
                              <span className="inline-flex items-center gap-1.5">
                                <ChevronRight className="h-3 w-3 transition-transform group-open/deactivated-danger:rotate-90 rtl:-scale-x-100" aria-hidden="true" />
                                {t('deactivatedTab.trackingCleanup')}
                              </span>
                              <span className="text-muted-foreground">{t('deactivatedTab.destructive')}</span>
                            </summary>
                            <div className="mt-2 flex flex-col gap-2 border-t border-border/40 pt-2 sm:flex-row sm:items-center sm:justify-between">
                              <p className="text-xs leading-4 text-muted-foreground">
                                {t('deactivatedTab.deleteHint')}
                              </p>
                              <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="self-start sm:self-auto"
                                  disabled={loading || (deactivatedIds.length === 0) || !canManageMods}
                                  onClick={async () => {
                                    if (!canManageMods) return
                                    const ids = someSelected ? selectedDeactivated : deactivatedIds
                                    const label = someSelected
                                      ? t('deactivatedTab.deleteSelectedConfirm', { count: ids.length })
                                      : t('deactivatedTab.deleteAllConfirm', { count: ids.length })
                                    // Only an INI untrack (files stay on disk, see deleteHint
                                    // above) -- not a disk delete, so no red/no-undo framing.
                                    const ok = await confirm({ title: t('deactivatedTab.deleteFromTrackingTitle'), description: label, confirmLabel: t('deactivatedTab.deleteConfirmButton'), destructive: false })
                                    if (!ok) return
                                    setSelectedMods(new Set(ids))
                                    handleBulkRemove(ids)
                                  }}
                                >
                                  <Trash2 aria-hidden="true" />
                                  {someSelected ? t('deactivatedTab.deleteSelected', { count: selectedDeactivated.length }) : t('deactivatedTab.deleteAll', { count: deactivatedIds.length })}
                                </Button>
                              </DisabledReason>
                            </div>
                          </details>
                          {missingNameCount > 0 && (
                            <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
                              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              <div className="flex flex-1 flex-wrap items-center gap-2">
                                <span className="min-w-0 flex-1">
                                  <Trans i18nKey="deactivatedTab.genericNameNotice" t={t} count={missingNameCount} values={{ count: missingNameCount }} components={{ 1: <strong className="text-foreground" />, 3: <strong /> }} />
                                </span>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={loading || !canManageMods}
                                  onClick={() => {
                                    const targets = deactivatedMods
                                      .filter(m => !m.name || /^Workshop Mod /i.test(m.name))
                                      .map(m => m.workshop_id)
                                    handleRefreshNames(targets)
                                  }}
                                >
                                  <RefreshCw className={loading ? 'animate-spin' : undefined} aria-hidden="true" />
                                  {t('deactivatedTab.refreshNames')}
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Rows: per-row Enable + Delete; checkbox for bulk select */}
                    <div className="divide-y divide-border/40">
                      {shownDeactivated.length === 0 && (
                        <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('activeMods.noMatchesFor', { query: searchQuery })}</p>
                      )}
                      {shownDeactivated.map(mod => {
                        const isSelected = selectedMods.has(mod.workshop_id)
                        const name = mod.name || t('deactivatedTab.workshopModFallback', { id: mod.workshop_id })
                        return (
                          <div
                            key={mod.id}
                            className={cn('group/modrow flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40', isSelected && 'bg-accent/30')}
                          >
                            <div className="shrink-0">
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() => toggleModSelect(mod.workshop_id)}
                                aria-label={t('deactivatedTab.selectAria', { name: mod.name || mod.workshop_id })}
                              />
                            </div>
                            <a
                              href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshop_id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="relative grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-md border border-border/50 bg-muted/30 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                              aria-label={t('deactivatedTab.openOnSteamAria', { name })}
                              title={t('deactivatedTab.openWorkshopPageTitle')}
                            >
                              <Package className="h-6 w-6" aria-hidden="true" />
                              <img
                                src={demoMode ? `${import.meta.env.BASE_URL}spiffo.png` : `/api/mods/thumbnail/${mod.workshop_id}`}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                className="absolute inset-0 h-full w-full rounded-md object-cover opacity-80"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                              />
                            </a>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate text-sm font-medium text-foreground">{name}</span>
                                <NoteIndicator note={notesStore.notes[mod.workshop_id]} onOpen={() => setNoteEditor({ workshopId: mod.workshop_id, name })} />
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                                <WorkshopIdChip
                                  wsId={mod.workshop_id}
                                  onCopied={(id) => toast({ title: t('installedTab.copiedTitle'), description: t('installedTab.copiedWorkshopId', { id }) })}
                                />
                                {mod.last_checked && (
                                  <span>{t('deactivatedTab.checkedOn', { date: formatDate(mod.last_checked) })}</span>
                                )}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-0.5">
                              <WorkshopLinkAction wsId={mod.workshop_id} label={name} hint={t('deactivatedTab.openWorkshopPageTooltip')} />
                              <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleEnableMod(mod.workshop_id)}
                                  disabled={loading || !canManageMods}
                                  aria-label={t('deactivatedTab.reEnableAria', { name: mod.name || mod.workshop_id })}
                                  // eslint-disable-next-line local/no-dead-disabled-title -- pure hint (what re-enabling does); the disabled-reason lives in the wrapping DisabledReason.
                                  title={t('deactivatedTab.reEnableTooltip')}
                                >
                                  <PlusCircle aria-hidden="true" />
                                  <span className="hidden sm:inline">{t('deactivatedTab.reEnable')}</span>
                                </Button>
                              </DisabledReason>
                              <RowActions
                                ariaLabel={t('rowMenu.actionsAria', { name })}
                                items={[
                                  noteMenuItem(mod.workshop_id, name),
                                  {
                                    label: t('deactivatedTab.deleteTooltip'),
                                    icon: Trash2,
                                    destructive: true,
                                    onSelect: () => setConfirmRemoveMod({ wsId: mod.workshop_id, label: mod.name || mod.workshop_id }),
                                    disabled: loading || !canManageMods,
                                    reason: !canManageMods ? t('permissions.noModsManage') : undefined,
                                  },
                                ]}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </SectionCard>

              {/* Mods downloaded into the Workshop content folder but not in the
                  server INI's WorkshopItems= list. Each row's Enable adds it to
                  the INI (and lifts any ignore-list entry). */}
              <SectionCard
                title={t('disabledPanel.sectionTitle')}
                description={t('disabledPanel.description')}
                icon={HardDrive}
                status={disabledScanned && !disabledLoading ? <Badge variant="outline" className="tabular-nums">{disabledMods.length}</Badge> : undefined}
                flush
                actions={
                  <>
                    <Button variant="ghost" size="sm" onClick={fetchDisabled} disabled={disabledLoading}>
                      {disabledLoading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                      {/* Icon-only on a phone, so the card's title keeps its line. */}
                      <span className="sr-only sm:not-sr-only">{t('disabledPanel.refresh')}</span>
                    </Button>
                    {disabledMods.length > 0 && !disabledLoading && (
                      <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={handleDeleteAllDisabled}
                          disabled={deletingId !== null || loading || !canManageMods}
                        >
                          {deletingId === '__batch_disabled__' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                          <span className="sr-only sm:not-sr-only">{t('disabledPanel.deleteAll')}</span>
                        </Button>
                      </DisabledReason>
                    )}
                  </>
                }
              >
                {disabledLoading ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground" role="status">
                    <Loader2 className="me-2 inline h-4 w-4 animate-spin" aria-hidden="true" />
                    {t('disabledPanel.scanning')}
                  </div>
                ) : disabledMods.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {disabledScanned ? t('disabledPanel.empty') : t('disabledPanel.notScanned')}
                  </div>
                ) : (
                  <div className="divide-y divide-border/40">
                    {disabledMods.map((mod) => (
                      <div key={mod.workshop_id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 text-sm sm:flex-nowrap">
                        {/* Full width on a phone (the buttons go under it), so the name stays readable. */}
                        <div className="flex min-w-0 basis-full items-center gap-2 sm:basis-auto">
                          <Package className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span className="truncate text-foreground">{mod.name}</span>
                          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{mod.workshop_id}</span>
                        </div>
                        <div className="ms-auto flex shrink-0 items-center gap-1">
                          <WorkshopLinkAction wsId={mod.workshop_id} label={mod.name || mod.workshop_id} hint={t('disabledPanel.openWorkshopPage')} />
                          <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleEnableDiskMod(mod.workshop_id)}
                              disabled={enablingId === mod.workshop_id || deletingId !== null || loading || !canManageMods}
                            >
                              {enablingId === mod.workshop_id ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
                              {t('disabledPanel.enable')}
                            </Button>
                          </DisabledReason>
                          <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                            <Button
                              variant="ghost"
                              size="iconDense"
                              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => handleDeleteDiskMod(mod.workshop_id, mod.name)}
                              disabled={deletingId !== null || enablingId === mod.workshop_id || loading || !canManageMods}
                              aria-label={t('disabledPanel.deleteFromDiskAria', { name: mod.name || mod.workshop_id })}
                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint (what the icon does); the disabled-reason lives in the wrapping DisabledReason.
                              title={t('disabledPanel.deleteFromDisk')}
                            >
                              {deletingId === mod.workshop_id ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                            </Button>
                          </DisabledReason>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>

              {/* Ignored mods: auto-sync and collection import won't add them back. */}
              {ignoredMods.length > 0 && (
                <SectionCard
                  title={t('ignoredPanel.count', { count: ignoredMods.length })}
                  description={t('ignoredPanel.description')}
                  icon={EyeOff}
                  collapsible
                  defaultOpen={false}
                  storageKey="zcp:mods:ignoredOpen"
                  flush
                >
                  {/* The bulk actions sit above the list, not below it: with hundreds of
                      entries the bottom of the list is a long scroll away. */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-2">
                    <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox
                        checked={selectedIgnored.size === ignoredMods.length}
                        onCheckedChange={() =>
                          setSelectedIgnored(
                            selectedIgnored.size === ignoredMods.length
                              ? new Set()
                              : new Set(ignoredMods.map(m => m.workshop_id)),
                          )
                        }
                        disabled={loading || deletingId !== null || !canManageMods}
                      />
                      {t('ignoredPanel.selectAll')}
                    </label>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleUnignoreSelected}
                        disabled={selectedIgnored.size === 0 || loading || deletingId !== null || !canManageMods}
                      >
                        {t('ignoredPanel.removeSelected', { n: selectedIgnored.size })}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={handleClearAllIgnored}
                        disabled={loading || deletingId !== null || !canManageMods}
                      >
                        {t('ignoredPanel.clearAllIgnored')}
                      </Button>
                    </div>
                  </div>
                  <div className="max-h-96 space-y-1 overflow-y-auto px-4 py-2">
                    {ignoredMods.map((mod) => {
                      const label = mod.name || t('ignoredPanel.workshopModFallback', { id: mod.workshop_id })
                      return (
                        <div key={mod.workshop_id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                          <div className="flex min-w-0 items-center gap-2">
                            <Checkbox
                              checked={selectedIgnored.has(mod.workshop_id)}
                              onCheckedChange={() => toggleIgnoredSelect(mod.workshop_id)}
                              disabled={loading || deletingId !== null || !canManageMods}
                              aria-label={t('ignoredPanel.selectRow', { name: label })}
                            />
                            <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                            <span className="truncate text-muted-foreground">{label}</span>
                            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{mod.workshop_id}</span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleUnignoreMod(mod.workshop_id)}
                                  disabled={loading || deletingId !== null || !canManageMods}
                                >
                                  {t('ignoredPanel.reTrack')}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">{t('ignoredPanel.reTrackHint')}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="iconDense"
                                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                  onClick={() => handleDeleteDiskMod(mod.workshop_id, mod.name || undefined)}
                                  disabled={deletingId !== null || loading || !canManageMods}
                                  aria-label={t('ignoredPanel.deleteFromDisk')}
                                >
                                  {deletingId === mod.workshop_id ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">{t('ignoredPanel.deleteFromDisk')}</TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <div className="flex justify-end gap-1 border-t border-border/40 px-4 pb-2 pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={handleDeleteAllIgnoredFromDisk}
                      disabled={loading || deletingId !== null || !canManageMods}
                    >
                      {deletingId === '__batch_ignored__' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                      {t('ignoredPanel.deleteAllFromDisk')}
                    </Button>
                  </div>
                </SectionCard>
              )}
            </>
          )}

          {/* Server config views (Active, Load order, Presets, Tools) need the server's INI. */}
          {CONFIG_VIEWS.includes(activeTab) && !iniConfig?.configured && (
            <SectionCard title={t(`nav.${activeTab}.label`)} description={t(`nav.${activeTab}.hint`)} icon={VIEW_ICONS[activeTab]}>
              {initialLoading ? (
                <div className="space-y-2" role="status" aria-label={t('installedTab.loading')}>
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/3" />
                </div>
              ) : (
                <div className="py-6 text-center">
                  <FileText className="mx-auto mb-4 h-10 w-10 text-muted-foreground" aria-hidden="true" />
                  {iniConfig?.code && FOLDER_REFUSAL_CODES.has(iniConfig.code) ? (
                    // PT3: the server's folders were refused (the data folder
                    // no longer meets the data-folder rule, or a config folder
                    // has no data folder): the refusal says what to set, and
                    // starting the server won't make the ini appear here.
                    <p className="mx-auto max-w-xl text-muted-foreground">
                      {getResultErrorMessage(iniConfig, t('serverConfigTab.notConfiguredTitle'))}
                    </p>
                  ) : (
                    <>
                      <p className="text-muted-foreground">{iniConfig?.error || t('serverConfigTab.notConfiguredTitle')}</p>
                      <p className="text-sm text-muted-foreground">{t('serverConfigTab.notConfiguredHint')}</p>
                    </>
                  )}
                </div>
              )}
            </SectionCard>
          )}

          {/* ═══ ACTIVE ON SERVER ═══ */}
          {activeTab === 'active' && iniConfig?.configured && (() => {
            const { orphaned, enabledCount, multiIdCount, groups, missingDepsMap, duplicateModIds } = activeModsData
            const totalModCount = groups.reduce((s, g) => s + g.mods.length, 0)
            const q = deferredModManagerSearch.toLowerCase().trim()
            const inspectedGroup = groups.find(g => g.wsId === selectedActiveWsId) || displayGroups[0] || null
            const inspectedLocked = !!inspectedGroup && isBridgeGroup(inspectedGroup)
            const inspectedLockReason = !canManageMods ? t('permissions.noModsManage') : inspectedLocked ? bridgeLockReason : null
            const copyWs = (wsId: string) => copyText(wsId).then(() => toast({ title: t('installedTab.copiedTitle'), description: t('installedTab.copiedWorkshopId', { id: wsId }) })).catch(() => {})
            // Enabled IDs that are not on disk: shown unfiltered and under "Needs
            // attention" (they never load), hidden by every other filter.
            const showOrphans = !multiIdFilterOn && !filterNotEnabled && activeChips.every((chip) => chip.key === 'attention')

            const renderActiveRow = (g: WsGroup) => {
              const isSingle = g.mods.length === 1
              const mod0 = g.mods[0]
              const isInspected = inspectedGroup?.wsId === g.wsId
              const label = getGroupLabel(g)
              const att = groupAttention(g)
              const bridgeLocked = isBridgeGroup(g)
              const rowLockReason = !canManageMods ? t('permissions.noModsManage') : bridgeLocked ? bridgeLockReason : null
              const enabledN = g.mods.filter(m => m.enabled).length
              const totalN = g.mods.length
              const tracked = trackedByWs.get(g.wsId)
              const itemGroups = groupsOfWorkshop(g.wsId)
              // Chips are the dense part of the row. Compact keeps them in the
              // inspector; the selected row always shows them so a click still
              // reveals everything in place.
              const showChips = !isSingle && (activeDensity === 'detailed' || isInspected)
              const groupMissing = g.mods.flatMap(m => missingDepsMap.get(m.id) || [])
              const groupRequires = g.mods.flatMap(m => m.require || []).filter((v, i, a) => a.indexOf(v) === i)
              const missingRequired = groupRequires.filter(dep => groupMissing.includes(dep))

              // Only colour the count when something is actually wrong. A partial
              // "1 of 5" is the normal, correct state for most multi-ID items.
              const countTone = att.any
                ? 'border-destructive/40 bg-destructive/10 text-foreground'
                : g.allEnabled
                  ? 'border-success/30 bg-success/10 text-foreground'
                  : 'border-border/50 bg-muted/30 text-muted-foreground'

              const menu = (
                <RowActions
                  ariaLabel={t('activeMods.moreActionsAria', { name: label })}
                  items={[
                    { label: t('activeMods.copyWorkshopId'), icon: FileText, onSelect: () => void copyWs(g.wsId) },
                    ...groupMenuItems(g.mods.map(m => m.id), label),
                    noteMenuItem(g.wsId, label),
                    {
                      label: t('activeMods.removeFromIni'),
                      icon: Trash2,
                      destructive: true,
                      onSelect: () => { if (!canManageMods || bridgeLocked) return; setConfirmRemoveWorkshop({ wsId: g.wsId, knownModIds: g.mods.map(m => m.id) }) },
                      disabled: !canManageMods || bridgeLocked,
                      reason: rowLockReason ?? undefined,
                    },
                    {
                      label: t('activeMods.removeFromServer'),
                      icon: Trash2,
                      destructive: true,
                      onSelect: () => { if (!canManageMods || bridgeLocked) return; setConfirmRemoveMod({ wsId: g.wsId, label }) },
                      disabled: !canManageMods || bridgeLocked,
                      reason: rowLockReason ?? undefined,
                    },
                  ]}
                />
              )

              // One kind chip per kind among the enabled mods (two at most).
              const kindInsights = [...new Map(g.mods.filter((m) => m.enabled).map((m) => smartInsightOf(m.id)).filter((i) => !!i).map((i) => [i!.kind, i!])).values()].slice(0, 2)
              const extraBadges = (
                <>
                  {kindInsights.map((insight) => <KindChip key={insight.kind} insight={insight} showDependents />)}
                  <GroupDots groups={itemGroups} />
                  <NoteIndicator note={notesStore.notes[g.wsId]} onOpen={() => setNoteEditor({ workshopId: g.wsId, name: label })} />
                  {tracked?.update_available ? (
                    <a
                      href={changelogUrl(g.wsId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(event) => event.stopPropagation()}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 text-[11px] font-medium text-foreground hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                      aria-label={t('whatChanged.aria', { name: label })}
                    >
                      <History className="h-3 w-3 text-warning" aria-hidden="true" />
                      {t('whatChanged.updateLabel')}
                    </a>
                  ) : null}
                </>
              )

              const selectBox = activeSelecting ? (
                <Checkbox
                  checked={selectedActiveWs.has(g.wsId)}
                  onCheckedChange={(checked) => setSelectedActiveWs((prev) => {
                    const next = new Set(prev)
                    if (checked === true) next.add(g.wsId)
                    else next.delete(g.wsId)
                    return next
                  })}
                  onClick={(event) => event.stopPropagation()}
                  aria-label={t('activeMods.selectItemAria', { name: label })}
                />
              ) : null

              const missingRequiredBlock = missingRequired.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1">
                  <AlertTriangle className="h-3 w-3 text-destructive" aria-hidden="true" />
                  <span className="text-xs font-medium text-foreground">{t('activeMods.missingRequiredId')}</span>
                  {missingRequired.map(dep => (
                    <span key={dep} className="rounded border border-destructive/30 bg-destructive/15 px-1 font-mono text-[10px] text-foreground" title={t('activeMods.missingRequiredTooltip', { dep })}>
                      {dep}
                    </span>
                  ))}
                </div>
              ) : null

              if (isSingle) {
                return (
                  <ModRow
                    key={g.wsId}
                    selected={isInspected}
                    dimmed={!mod0.enabled}
                    onClick={() => setSelectedActiveWsId(g.wsId)}
                    leading={
                      <div className="flex items-center gap-2">
                        {selectBox}
                        <DisabledReason reason={bridgeLocked ? bridgeLockReason : null}>
                          <Checkbox
                            checked={mod0.enabled}
                            onCheckedChange={() => toggleMod(mod0, g.wsId)}
                            disabled={bridgeLocked}
                            aria-label={t('activeMods.toggleEnableAria', { action: mod0.enabled ? t('activeMods.disableAction') : t('activeMods.enableAction'), name: mod0.name || mod0.id })}
                          />
                        </DisabledReason>
                      </div>
                    }
                    title={<span className="truncate text-sm font-semibold leading-tight text-foreground">{mod0.name || mod0.id}</span>}
                    titleBadges={
                      <>
                        {mod0.name !== mod0.id && (
                          <span className="inline-flex items-center rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                            {mod0.id}
                          </span>
                        )}
                        {att.duplicate && (
                          <span className="shrink-0 rounded border border-warning/40 bg-warning/15 px-1.5 text-[10px] text-foreground" title={duplicateSentenceOf(mod0.id)}>
                            {t('activeMods.duplicate')}
                          </span>
                        )}
                        {bridgeLocked && <BridgeManagedBadge />}
                        {extraBadges}
                      </>
                    }
                    meta={
                      <>
                        <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium', mod0.enabled ? 'border-success/30 bg-success/10 text-foreground' : 'border-border/50 bg-muted/30 text-muted-foreground')}>
                          <span className={cn('h-1.5 w-1.5 rounded-full', mod0.enabled ? 'bg-success' : 'bg-muted-foreground/50')} aria-hidden="true" />
                          {mod0.enabled ? t('activeMods.enabled') : t('activeMods.disabled')}
                        </span>
                        <WorkshopIdChip wsId={g.wsId} onCopied={(id) => toast({ title: t('installedTab.copiedTitle'), description: t('installedTab.copiedWorkshopId', { id }) })} />
                      </>
                    }
                    actions={
                      <>
                        <WorkshopLinkAction wsId={g.wsId} label={mod0.name || mod0.id} />
                        {menu}
                      </>
                    }
                    footer={mod0.enabled ? missingRequiredBlock : null}
                  />
                )
              }

              return (
                <ModRow
                  key={g.wsId}
                  selected={isInspected}
                  dimmed={!g.someEnabled}
                  onClick={() => setSelectedActiveWsId(g.wsId)}
                  leading={
                    <div className="flex items-center gap-2">
                      {selectBox}
                      <div className={cn('h-2 w-2 rounded-sm', g.allEnabled ? 'bg-success' : g.someEnabled ? 'bg-success/40' : 'bg-muted-foreground/20')} aria-hidden="true" />
                    </div>
                  }
                  title={<span className="truncate text-sm font-semibold leading-tight text-foreground">{label}</span>}
                  titleBadges={
                    <>
                      <span
                        className={cn('inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium tabular-nums', countTone)}
                        title={t('activeMods.enabledOfTotalTooltip', { enabled: enabledN, total: totalN })}
                      >
                        <span>{enabledN}</span>
                        <span className="opacity-60">{t('activeMods.of')}</span>
                        <span>{totalN}</span>
                        <span className="hidden opacity-75 sm:inline">{t('activeMods.enabledLabel')}</span>
                      </span>
                      {bridgeLocked && <BridgeManagedBadge />}
                      {extraBadges}
                    </>
                  }
                  meta={<WorkshopIdChip wsId={g.wsId} onCopied={(id) => toast({ title: t('installedTab.copiedTitle'), description: t('installedTab.copiedWorkshopId', { id }) })} />}
                  actions={
                    <>
                      <WorkshopLinkAction wsId={g.wsId} label={label} hint={t('activeMods.openWorkshopToChooseHint')} />
                      {menu}
                    </>
                  }
                  footer={
                    <>
                      {showChips && (
                        <div className="flex flex-wrap gap-1">
                          {(() => {
                            const groupSiblings = siblingConflictsMap.get(g.wsId)
                            // `conflicts` is null until a scan has ever run: an
                            // unscanned pill gets the dashed "unverified" look,
                            // never the green a scanned-and-clean mod earns.
                            const scanned = conflicts !== null
                            const enabledSet = new Set(g.mods.filter(m => m.enabled).map(m => m.id))
                            const scanClashing = new Set<string>()
                            if (groupSiblings) {
                              for (const [modId, sibs] of groupSiblings) {
                                if (!enabledSet.has(modId)) continue
                                for (const s of sibs) {
                                  if (enabledSet.has(s)) { scanClashing.add(modId); scanClashing.add(s) }
                                }
                              }
                            }
                            return g.mods.map(mod => {
                              const isDupe = duplicateModIds.has(mod.id)
                              const sibConflicts = groupSiblings?.get(mod.id)
                              const hasScanOverlap = !!sibConflicts && sibConflicts.size > 0
                              const isScanClashing = scanClashing.has(mod.id)
                              const sibList = sibConflicts ? Array.from(sibConflicts) : []
                              const enabledSibs = sibList.filter(s => enabledSet.has(s))
                              const fmtSibs = (arr: string[]) => arr.length <= 4 ? arr.join(', ') : `${arr.slice(0, 4).join(', ')} (+${arr.length - 4} more)`
                              const tooltipBits = [
                                `${mod.id}${mod.name !== mod.id ? ` — ${mod.name}` : ''}`,
                                isDupe ? duplicateSentenceOf(mod.id) : null,
                                isScanClashing
                                  ? t('activeMods.chipTooltipClash', { names: fmtSibs(enabledSibs) })
                                  : hasScanOverlap
                                    ? t('activeMods.chipTooltipOverlap', { names: fmtSibs(sibList) })
                                    : null,
                                mod.enabled ? t('activeMods.clickToDisable') : t('activeMods.clickToEnable'),
                              ].filter(Boolean).join('\n')
                              // Colour priority: confirmed clash > known overlap > duplicate > normal.
                              const styleClass = isScanClashing
                                ? (mod.enabled ? 'bg-destructive/20 text-destructive hover:bg-destructive/30 ring-1 ring-destructive/50' : 'bg-destructive/5 text-destructive/60 hover:bg-destructive/10 ring-1 ring-destructive/20')
                                : hasScanOverlap
                                  ? (mod.enabled ? 'bg-success/15 text-success hover:bg-success/25 ring-1 ring-warning/30' : 'bg-muted/15 text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted/25 ring-1 ring-warning/20')
                                  : isDupe
                                    ? (mod.enabled ? 'bg-warning/15 text-warning hover:bg-warning/25 ring-1 ring-warning/30' : 'bg-warning/5 text-warning/50 hover:bg-warning/10 ring-1 ring-warning/20')
                                    : !scanned
                                      ? (mod.enabled
                                        ? 'border border-dashed border-muted-foreground/40 bg-transparent text-muted-foreground/70 hover:bg-muted/15'
                                        : 'border border-dashed border-muted-foreground/25 bg-transparent text-muted-foreground/40 hover:bg-muted/10')
                                      : (mod.enabled
                                        ? 'bg-success/15 text-success hover:bg-success/25'
                                        : 'bg-muted/15 text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted/25')
                              return (
                                <DisabledReason key={mod.id} reason={rowLockReason}>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggleMod(mod, g.wsId) }}
                                    disabled={!canManageMods || bridgeLocked}
                                    // eslint-disable-next-line local/no-dead-disabled-title -- the disabled-reason branch (mods.manage) lives in the DisabledReason wrapper above; this title carries only the always-relevant chip tooltip (id/name, dupe/clash/overlap warnings, click hint), correctly absent rather than dead when actually disabled.
                                    title={tooltipBits}
                                    className={`mod-toggle-pill inline-flex max-w-[200px] items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${canManageMods ? 'cursor-pointer' : ''} ${styleClass}`}
                                  >
                                    {isScanClashing && <AlertTriangle className="h-2.5 w-2.5 shrink-0 text-destructive" />}
                                    {!isScanClashing && hasScanOverlap && <AlertTriangle className="h-2.5 w-2.5 shrink-0 text-warning/70" />}
                                    <span className="truncate">{mod.id}</span>
                                  </button>
                                </DisabledReason>
                              )
                            })
                          })()}
                        </div>
                      )}
                      {(() => {
                        const enabledMods = g.mods.filter(m => m.enabled)
                        const enabledIds = enabledMods.map(m => m.id)
                        const enabledSet = new Set(enabledIds)
                        const hasMultipleEnabled = g.mods.length > 1 && enabledIds.length >= 2
                        const groupSiblings = siblingConflictsMap.get(g.wsId)
                        const scanClashingPairs: [string, string][] = []
                        if (groupSiblings) {
                          const seen = new Set<string>()
                          for (const [modId, sibs] of groupSiblings) {
                            if (!enabledSet.has(modId)) continue
                            for (const s of sibs) {
                              if (!enabledSet.has(s)) continue
                              const key = [modId, s].sort().join('--')
                              if (seen.has(key)) continue
                              seen.add(key)
                              scanClashingPairs.push([modId, s])
                            }
                          }
                        }
                        // Dismissed false positives, so a wrong "Not a conflict" can be undone.
                        const groupModIds = new Set(g.mods.map(m => m.id))
                        const dismissedHere = ignoredPairs.filter(p => groupModIds.has(p.mod_a) && groupModIds.has(p.mod_b))

                        // A real clash always shows, at any density.
                        if (scanClashingPairs.length > 0) {
                          return (
                            <div role="alert" className="flex flex-wrap items-start gap-1.5 text-xs sm:items-center">
                              <AlertTriangle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-destructive sm:mt-0" />
                              <span className="min-w-0 break-words font-medium text-foreground">
                                {t('activeMods.clashWarning')}
                              </span>
                              <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    for (const [a, b] of scanClashingPairs) dismissPair(a, b)
                                  }}
                                  disabled={!canManageMods}
                                  // eslint-disable-next-line local/no-dead-disabled-title -- the disabled-reason branch (mods.manage) lives in the DisabledReason wrapper above; this title carries only the always-relevant dismiss-pair hint, correctly absent rather than dead when actually disabled.
                                  title={scanClashingPairs.length === 1
                                    ? t('activeMods.dismissOneTooltip', { a: scanClashingPairs[0][0], b: scanClashingPairs[0][1] })
                                    : t('activeMods.dismissAllTooltip', { count: scanClashingPairs.length })}
                                  className="ms-auto inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {t('activeMods.notAConflict')}
                                </button>
                              </DisabledReason>
                            </div>
                          )
                        }

                        // Everything below is reassurance or nuance, not a problem —
                        // it only earns space in the detailed density.
                        if (activeDensity !== 'detailed' && !isInspected) return null

                        if (groupSiblings && groupSiblings.size > 0) {
                          const overlapIds = new Set<string>()
                          for (const [id, sibs] of groupSiblings) if (sibs.size > 0) overlapIds.add(id)
                          return (
                            <div
                              className="flex flex-wrap items-start gap-1 text-xs text-muted-foreground sm:items-center"
                              title={t('activeMods.variantsShareFilesTooltip', { ids: Array.from(overlapIds).join(', ') })}
                            >
                              <Check aria-hidden="true" className="mt-px h-3 w-3 shrink-0 text-success sm:mt-0" />
                              <span className="min-w-0 break-words">{t('activeMods.variantsShareFiles')}</span>
                            </div>
                          )
                        }
                        if (hasMultipleEnabled) {
                          return (
                            <div className="flex flex-wrap items-start gap-1 text-xs text-muted-foreground sm:items-center">
                              <Info aria-hidden="true" className="mt-px h-3 w-3 shrink-0 sm:mt-0" />
                              <span className="min-w-0 break-words">{t('activeMods.multipleEnabledHint', { count: enabledIds.length })}</span>
                              {dismissedHere.length > 0 && (
                                <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); for (const p of dismissedHere) restorePair(p.mod_a, p.mod_b) }}
                                    disabled={!canManageMods}
                                    // eslint-disable-next-line local/no-dead-disabled-title -- the disabled-reason branch (mods.manage) lives in the DisabledReason wrapper above; this title carries only the always-relevant restore-dismissed hint, correctly absent rather than dead when actually disabled.
                                    title={t('activeMods.restoreDismissedTooltip', { count: dismissedHere.length })}
                                    className="ms-auto text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {t('activeMods.restoreDismissed', { count: dismissedHere.length })}
                                  </button>
                                </DisabledReason>
                              )}
                            </div>
                          )
                        }
                        if (dismissedHere.length > 0) {
                          return (
                            <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                              <span className="min-w-0">{t('activeMods.dismissedCount', { count: dismissedHere.length })}</span>
                              <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); for (const p of dismissedHere) restorePair(p.mod_a, p.mod_b) }}
                                  disabled={!canManageMods}
                                  className="underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {t('activeMods.restore')}
                                </button>
                              </DisabledReason>
                            </div>
                          )
                        }
                        return null
                      })()}
                      {g.someEnabled ? missingRequiredBlock : null}
                    </>
                  }
                />
              )
            }

            // PanelBridge's mod id shows as "not on disk" until Steam has
            // downloaded its Workshop item (the first start after a switch),
            // so the same lock applies.
            const orphanRows = showOrphans ? orphaned.filter(id => !q || id.toLowerCase().includes(q)).map(id => {
              const orphanBridgeLocked = isBridgeManagedMod(iniConfig?.bridgeManaged, null, [id])
              return (
                <div key={`orphan-${id}`} className="group flex items-center gap-3 px-3 py-1.5 opacity-70">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                  <span className="flex-1 truncate font-mono text-xs">{id}</span>
                  {orphanBridgeLocked && <BridgeManagedBadge />}
                  <span className="text-xs text-muted-foreground">{t('activeMods.orphanNotOnDisk')}</span>
                  <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : orphanBridgeLocked ? bridgeLockReason : null}>
                    <button
                      onClick={async () => {
                        if (busyRef.current || !canManageMods || orphanBridgeLocked) return
                        busyRef.current = true
                        try {
                          await modsApi.toggleModId(id, false)
                          const updated = await modsApi.getCurrentConfig()
                          setIniConfig(updated)
                          if (updated?.modIds) syncOrderFromServer(updated.modIds)
                        } catch (e) { reportClientError('Failed to remove orphaned mod', e); toast({ variant: 'destructive', title: t('toasts.failedToRemoveOrphanedModTitle'), description: getUserErrorMessage(e, t('toasts.failedToRemoveOrphanedModFallback')) }) } finally { busyRef.current = false }
                      }}
                      disabled={!canManageMods || orphanBridgeLocked}
                      className="grid h-8 w-8 place-items-center rounded text-destructive/80 transition-colors duration-150 hover:bg-destructive/15 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/50 disabled:cursor-not-allowed disabled:opacity-40"
                      // eslint-disable-next-line local/no-dead-disabled-title -- pure hint (what removing this orphan does); the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                      title={t('activeMods.removeOrphanTooltip', { id })}
                      aria-label={t('activeMods.removeOrphanAria', { id })}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </DisabledReason>
                </div>
              )
            }) : []

            const emptyList = (
              <div className="space-y-2 px-3 py-8 text-center text-sm text-muted-foreground">
                {filterAttention && activeCounts.attention === 0 ? (
                  <>
                    <p className="text-foreground">{t('activeMods.nothingNeedsAttention')}</p>
                    <button type="button" onClick={() => setFilterAttention(false)} className="underline underline-offset-2 hover:text-foreground">
                      {t('activeMods.showAllItems')}
                    </button>
                  </>
                ) : filterNotEnabled && activeCounts.notEnabled === 0 ? (
                  <>
                    <p className="text-foreground">{t('activeMods.everythingEnabled')}</p>
                    <button type="button" onClick={() => setFilterNotEnabled(false)} className="underline underline-offset-2 hover:text-foreground">
                      {t('activeMods.showAllItems')}
                    </button>
                  </>
                ) : q ? (
                  <p>{t('activeMods.noMatchesFor', { query: modManagerSearch })}</p>
                ) : activeChips.length > 0 ? (
                  <>
                    <p>{t('activeMods.noFilterMatches')}</p>
                    <button type="button" onClick={clearActiveFilters} className="underline underline-offset-2 hover:text-foreground">
                      {t('filters.clearAll')}
                    </button>
                  </>
                ) : (
                  <p>{t('activeMods.noModIdsFound')}</p>
                )}
              </div>
            )

            // Workshop items shipping the same mods, when one of those mods is
            // enabled: the sentence and "Keep <item>". A Mods= entry listed
            // twice is folded into its set's Keep (which keeps one entry);
            // any other repeated entry keeps its own line and Fix.
            const enabledIds = new Set(iniConfig.modIds)
            const bannerSets = duplicateSets.filter((s) => s.modIds.some((id) => enabledIds.has(id)))
            const coveredIds = new Set(bannerSets.flatMap((s) => s.modIds))
            const bannerConflicts = detectedConflicts
              .map((conflict) => conflict.type === 'duplicate'
                ? { ...conflict, modIds: (conflict.modIds ?? []).filter((id) => !coveredIds.has(id)) }
                : conflict)
              .filter((conflict) => conflict.type !== 'duplicate' || (conflict.modIds?.length ?? 0) > 0)
            return (
              <>
                <HealthSummaryCard health={smart.health.health} onReview={() => selectView('health')} />
                {(bannerConflicts.length > 0 || bannerSets.length > 0) && (
                  <div className="space-y-1.5">
                    {bannerSets.map(duplicateNotice)}
                    {bannerConflicts.map((conflict, idx) => (
                      <div
                        key={idx}
                        className={cn('flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm', conflict.severity === 'warning' ? 'border-warning/40 bg-warning/10' : 'border-border/60 bg-muted/40')}
                      >
                        <AlertTriangle className={cn('h-4 w-4 shrink-0', conflict.severity === 'warning' ? 'text-warning' : 'text-primary')} aria-hidden="true" />
                        {conflict.type === 'duplicate' ? (
                          <span className="min-w-0 flex-1 break-words text-foreground">
                            {t('serverConfigTab.duplicateModIdsFound', { ids: (conflict.modIds ?? []).join(', ') })}
                          </span>
                        ) : (
                          <span className="min-w-0 flex-1 break-words">
                            <span className="font-medium text-foreground">
                              {conflict.type === 'missing_modid' && t('serverConfigTab.missingModIdsTitle')}
                              {conflict.type === 'outdated_dependency' && t('serverConfigTab.outdatedDependencyTitle')}
                            </span>
                            <span className="text-muted-foreground">: {conflict.message}</span>
                          </span>
                        )}
                        {conflict.type === 'duplicate' && (
                          <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={deduplicating || !canManageMods}
                              onClick={async () => {
                                if (!canManageMods) return
                                setDeduplicating(true)
                                setDeduplicateResult(null)
                                try {
                                  const result = await modsApi.deduplicateModIds()
                                  setDeduplicateResult(result.message)
                                  if (result.removed.length > 0) {
                                    const updated = await modsApi.getCurrentConfig()
                                    setIniConfig(updated)
                                    if (updated?.modIds) syncOrderFromServer(updated.modIds)
                                  }
                                } catch (err: unknown) {
                                  const errMsg = getUserErrorMessage(err, 'Failed to deduplicate')
                                  const msg = errMsg.includes('<')
                                    ? t('serverConfigTab.deduplicateEndpointUnavailable')
                                    : errMsg
                                  setDeduplicateResult(t('serverConfigTab.deduplicateError', { message: msg }))
                                } finally {
                                  setDeduplicating(false)
                                }
                              }}
                            >
                              {deduplicating ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Wrench aria-hidden="true" />}
                              {t('serverConfigTab.removeExtraEntries')}
                            </Button>
                          </DisabledReason>
                        )}
                      </div>
                    ))}
                    {deduplicateResult && (
                      <p className="px-3 text-xs text-muted-foreground">{deduplicateResult}</p>
                    )}
                  </div>
                )}

                <SectionCard
                  title={t('nav.active.label')}
                  description={t('nav.active.hint')}
                  icon={Power}
                  flush
                  actions={
                    <Segmented<ListMode>
                      value={activeMode}
                      onValueChange={setActiveMode}
                      ariaLabel={t('listMode.aria')}
                      items={[
                        { value: 'list', label: t('listMode.list') },
                        { value: 'groups', label: t('listMode.groups') },
                      ]}
                    />
                  }
                >
                  <div className="space-y-3 border-b border-border/60 p-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-foreground"
                        title={t('activeMods.idsEnabledTooltip', { enabled: enabledCount, total: totalModCount })}
                      >
                        <span className="tabular-nums font-medium">{enabledCount}</span>
                        <span className="text-muted-foreground">{t('activeMods.of')}</span>
                        <span className="tabular-nums font-medium">{totalModCount}</span>
                        <span className="text-muted-foreground">{t('activeMods.idsEnabled')}</span>
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-muted-foreground">
                        <Package className="h-3 w-3" aria-hidden="true" />
                        <span className="tabular-nums text-foreground">{groups.length}</span>
                        {t('activeMods.workshopItems', { count: groups.length })}
                      </span>
                      {duplicateModIds.size > 0 && (
                        <span
                          className="inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 font-medium text-foreground"
                          title={duplicateSets.map((s) => duplicateSentenceOf(s.modIds[0])).join('\n')}
                        >
                          <AlertTriangle className="h-3 w-3 shrink-0 text-warning" aria-hidden="true" />
                          {t('activeMods.duplicateId', { count: duplicateModIds.size })}
                        </span>
                      )}
                      {lastSavedMod && (
                        <span className="flex items-center gap-1 text-success animate-in fade-in duration-300" role="status">
                          <Check className="h-3 w-3" aria-hidden="true" /> {t('activeMods.savedToIni')}
                        </span>
                      )}
                      {/* Collapsed by default: onboarding copy, not a status line. */}
                      <details className="group/help w-full">
                        <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 text-muted-foreground transition-colors hover:text-foreground">
                          <ChevronRight className="h-3 w-3 transition-transform group-open/help:rotate-90 rtl:-scale-x-100" aria-hidden="true" />
                          {t('activeMods.helpToggle')}
                        </summary>
                        <p className="mt-1.5 max-w-prose text-xs leading-5 text-muted-foreground">
                          {t('activeMods.helpText')}
                        </p>
                      </details>
                    </div>

                    <Toolbar
                      search={{
                        value: modManagerSearch,
                        onChange: handleModManagerSearchChange,
                        placeholder: t('activeMods.filterPlaceholder'),
                        ariaLabel: t('activeMods.filterAria'),
                        slashToFocus: true,
                      }}
                      end={
                        <>
                          <Segmented<'compact' | 'detailed'>
                            value={activeDensity}
                            onValueChange={setActiveDensity}
                            ariaLabel={t('activeMods.densityAria')}
                            items={[
                              { value: 'compact', label: t('activeMods.densityCompactLabel') },
                              { value: 'detailed', label: t('activeMods.densityDetailedLabel') },
                            ]}
                          />
                          <Button
                            variant={activeSelecting ? 'secondary' : 'outline'}
                            size="sm"
                            aria-pressed={activeSelecting}
                            onClick={() => { setActiveSelecting(!activeSelecting); setSelectedActiveWs(new Set()) }}
                          >
                            <Check aria-hidden="true" />
                            {t('activeMods.select')}
                          </Button>
                        </>
                      }
                    >
                      {/* One switch to jump straight to the items that are
                          actually broken, instead of scrolling for red. */}
                      {activeCounts.attention > 0 && (
                        <button
                          type="button"
                          onClick={() => setFilterAttention(!filterAttention)}
                          aria-pressed={filterAttention}
                          title={t('activeMods.needsAttentionTooltip')}
                          className={filterChipClass(filterAttention)}
                        >
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
                          {t('activeMods.needsAttention', { count: activeCounts.attention })}
                        </button>
                      )}
                      {multiIdCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setFilterMultiId(!filterMultiId)}
                          aria-pressed={filterMultiId}
                          title={filterMultiId ? t('activeMods.multiIdShowingTooltip') : t('activeMods.multiIdHint')}
                          className={filterChipClass(filterMultiId)}
                        >
                          <Filter className="h-3.5 w-3.5" aria-hidden="true" />
                          {t('activeMods.multiId', { count: multiIdCount })}
                        </button>
                      )}
                      {/* Kept while the filter is on even at zero, so it can be switched off again. */}
                      {(activeCounts.notEnabled > 0 || filterNotEnabled) && (
                        <button
                          type="button"
                          onClick={() => {
                            // Turning it on lists every item with a not-enabled ID, single-ID ones included:
                            // the Multi-ID filter (on by default) would otherwise hide most of them.
                            if (!filterNotEnabled) setFilterMultiId(false)
                            setFilterNotEnabled(!filterNotEnabled)
                          }}
                          aria-pressed={filterNotEnabled}
                          title={t('activeMods.notEnabledTooltip')}
                          className={filterChipClass(filterNotEnabled)}
                        >
                          <Filter className="h-3.5 w-3.5" aria-hidden="true" />
                          {t('activeMods.notEnabled', { count: activeCounts.notEnabled })}
                        </button>
                      )}
                      {(activeCounts.updates > 0 || activeFilters.updates) && (
                        <button
                          type="button"
                          onClick={() => setActiveFilters((f) => ({ ...f, updates: !f.updates }))}
                          aria-pressed={activeFilters.updates}
                          className={filterChipClass(activeFilters.updates)}
                        >
                          <History className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
                          {t('activeMods.updatesChip', { count: activeCounts.updates })}
                        </button>
                      )}
                      {(activeCounts.missingDep > 0 || activeFilters.missingDep) && (
                        <button
                          type="button"
                          onClick={() => setActiveFilters((f) => ({ ...f, missingDep: !f.missingDep }))}
                          aria-pressed={activeFilters.missingDep}
                          title={t('activeMods.missingDepTooltip')}
                          className={filterChipClass(activeFilters.missingDep)}
                        >
                          <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                          {t('activeMods.missingDep', { count: missingDepsMap.size })}
                        </button>
                      )}
                      {(activeCounts.hasNote > 0 || activeFilters.hasNote) && (
                        <button
                          type="button"
                          onClick={() => setActiveFilters((f) => ({ ...f, hasNote: !f.hasNote }))}
                          aria-pressed={activeFilters.hasNote}
                          className={filterChipClass(activeFilters.hasNote)}
                        >
                          <StickyNote className="h-3.5 w-3.5" aria-hidden="true" />
                          {t('activeMods.hasNoteChip', { count: activeCounts.hasNote })}
                        </button>
                      )}
                      {groupsStore.groups.length > 0 && renderGroupFilter(activeGroupFilter, (group) => setActiveFilters((f) => ({ ...f, group })))}
                      {(kindCounts.size > 0 || activeKind) && (
                        <Select value={activeKind ?? 'all'} onValueChange={setActiveKind}>
                          <SelectTrigger className="h-11 w-auto min-w-[8rem] gap-2 text-xs sm:h-8" aria-label={tSmart('filter.kindAria')}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">{tSmart('filter.allKinds')}</SelectItem>
                            {SHOWN_KINDS.filter((kind) => (kindCounts.get(kind) ?? 0) > 0 || kind === activeKind).map((kind) => (
                              <SelectItem key={kind} value={kind}>{tSmart('filter.option', { kind: tSmart(`kind.${kind}`), count: kindCounts.get(kind) ?? 0 })}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <Select value={activeSort} onValueChange={(value) => setActiveSort(ACTIVE_SORTS.includes(value as ActiveSort) ? (value as ActiveSort) : 'config')}>
                        <SelectTrigger className="h-11 w-auto min-w-[9rem] gap-2 text-xs sm:h-8" aria-label={t('sort.aria')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="config">{t('sort.config')}</SelectItem>
                          <SelectItem value="loadOrder">{t('sort.loadOrder')}</SelectItem>
                          <SelectItem value="name">{t('sort.name')}</SelectItem>
                          <SelectItem value="updated">{t('sort.updated')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </Toolbar>
                    {renderFilterChips(activeChips, clearActiveFilters)}
                    {activeSelecting && (
                      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('activeMods.selectionAria')}>
                        <span className="text-sm text-muted-foreground">{t('installedTab.selectedCount', { count: selectedActiveWs.size })}</span>
                        <Button variant="ghost" size="sm" onClick={() => setSelectedActiveWs(new Set(displayGroups.map((g) => g.wsId)))}>
                          {t('installedTab.selectAll', { count: displayGroups.length })}
                        </Button>
                        <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : selectedActiveWs.size === 0 ? tGroups('addTo.pickFirst') : null}>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setAddToGroup({ modIds: activeSelectionModIds })}
                            disabled={!canManageMods || selectedActiveWs.size === 0}
                          >
                            <FolderPlus aria-hidden="true" />
                            {tGroups('addTo.selected')}
                          </Button>
                        </DisabledReason>
                        <Button variant="ghost" size="sm" onClick={() => setSelectedActiveWs(new Set())} disabled={selectedActiveWs.size === 0}>
                          {t('loadOrder.clearSelection')}
                        </Button>
                      </div>
                    )}
                  </div>

                  {activeMode === 'groups' && (
                    <div className="border-b border-border/60 p-4 empty:hidden">
                      <GroupSuggestions
                        suggestions={activeSuggestions.suggestions}
                        modNames={modNamesRecord}
                        canManage={canManageMods}
                        onCreate={(suggestion) => setGroupEditor({ group: null, initialModIds: suggestion.modIds, initialName: suggestion.name, fromSuggestion: true })}
                        onDismiss={(suggestion) => {
                          void activeSuggestions.dismiss(suggestion.key).catch((error) => {
                            toast({ title: tGroups('suggestions.dismissFailedTitle'), description: getUserErrorMessage(error, tGroups('suggestions.dismissFailedFallback')), variant: 'destructive' })
                            void activeSuggestions.reload()
                          })
                        }}
                        storageKey="zcp:mods:suggestionsOpen:active"
                      />
                    </div>
                  )}

                  {/* The list and, from xl, the selected item's inspector. */}
                  <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_21rem]">
                    <div className="min-w-0">
                      {displayGroups.length === 0 && orphanRows.length === 0 ? (
                        emptyList
                      ) : activeMode === 'groups' ? (
                        <GroupSections
                          items={displayGroups.map((g) => ({ key: g.wsId, modIds: g.mods.map((m) => m.id), g }))}
                          renderItem={(item) => renderActiveRow(item.g)}
                          groups={groupsStore.groups}
                          enabledModIds={enabledModIds}
                          availableModIds={availableModIds}
                          modNames={modIdNameMap}
                          conflictsByGroup={conflictsByGroup}
                          onShowConflicts={showGroupConflicts}
                          canManage={canManageMods}
                          busyGroupId={busyGroupId}
                          onEnable={(group) => void handleEnableGroup(group)}
                          onDisable={(group) => void handleDisableGroup(group)}
                          onEdit={(group) => setGroupEditor({ group })}
                          applyOrder={{ run: () => void applyGroupOrder(), reason: applyOrderReason }}
                          hideEmptyGroups={!!q || activeChips.length > 0}
                          storageKey="zcp:mods:active:collapsedGroups"
                          className="h-[calc(100vh-340px)] min-h-[300px]"
                        />
                      ) : (
                        <VirtualRows
                          rows={[...displayGroups.map((g) => ({ kind: 'item' as const, g })), ...orphanRows.map((node) => ({ kind: 'orphan' as const, node }))]}
                          getKey={(row) => (row.kind === 'item' ? row.g.wsId : String(row.node.key))}
                          renderRow={(row) => (row.kind === 'item' ? renderActiveRow(row.g) : row.node)}
                          estimateSize={(row) => (row.kind === 'item' ? 64 : 36)}
                          className="h-[calc(100vh-340px)] min-h-[300px]"
                          listClassName="divide-y divide-border/60 [&>*:nth-child(even)]:bg-card/70"
                          virtualRowClassName={(_row, index) => cn('border-b border-border/60', index % 2 === 1 && 'bg-card/70')}
                        />
                      )}
                    </div>

                    {inspectedGroup && (
                      <aside className="border-t border-border/60 xl:sticky xl:top-3 xl:self-start xl:border-s xl:border-t-0" aria-label={t('activeMods.selectedItemAria')}>
                        <div className="border-b border-border/50 px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="label-micro">{t('activeMods.selectedItemLabel')}</p>
                              <h3 className="mt-1 truncate text-sm font-semibold text-foreground" title={getGroupLabel(inspectedGroup)}>{getGroupLabel(inspectedGroup)}</h3>
                            </div>
                            <span className={cn('inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs font-medium tabular-nums', inspectedGroup.allEnabled ? 'border-success/30 bg-success/10 text-foreground' : inspectedGroup.someEnabled ? 'border-warning/40 bg-warning/10 text-foreground' : 'border-border/50 bg-muted/30 text-muted-foreground')}>
                              {inspectedGroup.mods.filter(m => m.enabled).length} {t('activeMods.of')} {inspectedGroup.mods.length}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="inline-flex items-center rounded border border-border/50 bg-muted/30 px-1.5 py-0.5 font-mono tabular-nums">WS {inspectedGroup.wsId}</span>
                            {inspectedGroup.mods.length > 1 && <span className="inline-flex items-center rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-foreground">{t('activeMods.multiIdBadge')}</span>}
                            {inspectedLocked && <BridgeManagedBadge />}
                          </div>
                        </div>

                        <div className="space-y-4 px-4 py-3">
                          <div className="grid grid-cols-2 gap-2">
                            <a
                              href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${inspectedGroup.wsId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2 text-xs font-medium text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                            >
                              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                              {t('activeMods.workshop')}
                            </a>
                            <button
                              type="button"
                              onClick={() => void copyWs(inspectedGroup.wsId)}
                              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2 text-xs font-medium text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                            >
                              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                              {t('activeMods.copyWs')}
                            </button>
                          </div>

                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <p className="label-micro">{t('activeMods.loadedIds')}</p>
                              <DisabledReason reason={inspectedLockReason}>
                                <button
                                  type="button"
                                  onClick={() => toggleAllInGroup(inspectedGroup)}
                                  disabled={!canManageMods || inspectedLocked}
                                  className="rounded border border-border/50 bg-muted/30 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {inspectedGroup.allEnabled ? t('activeMods.disableAll') : t('activeMods.enableAll')}
                                </button>
                              </DisabledReason>
                            </div>
                            <div className="space-y-1.5">
                              {inspectedGroup.mods.map(mod => {
                                const missing = missingDepsMap.get(mod.id) || []
                                const isDupe = duplicateModIds.has(mod.id)
                                return (
                                  <DisabledReason key={mod.id} reason={inspectedLockReason}>
                                    <button
                                      type="button"
                                      onClick={() => toggleMod(mod, inspectedGroup.wsId)}
                                      disabled={!canManageMods || inspectedLocked}
                                      className={cn('flex w-full items-center gap-2 rounded border px-2 py-1.5 text-start text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50', mod.enabled ? 'border-success/30 bg-success/10 text-foreground' : 'border-border/50 bg-muted/20 text-muted-foreground hover:text-foreground')}
                                      // eslint-disable-next-line local/no-dead-disabled-title -- the disabled-reason branch (mods.manage) lives in the DisabledReason wrapper above; this title carries only the always-relevant click-to-toggle hint, correctly absent rather than dead when actually disabled.
                                      title={`${mod.enabled ? t('activeMods.clickToDisable') : t('activeMods.clickToEnable')} ${mod.id}`}
                                    >
                                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', mod.enabled ? 'bg-success' : 'bg-muted-foreground/50')} aria-hidden="true" />
                                      <span className="min-w-0 flex-1 truncate font-mono">{mod.id}</span>
                                      {missing.length > 0 && <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" aria-label={t('activeMods.missingDependencyAria')} />}
                                      {isDupe && <span className="shrink-0 rounded border border-warning/40 bg-warning/10 px-1 py-0 text-[10px] text-foreground" title={duplicateSentenceOf(mod.id)}>{t('activeMods.dupBadge')}</span>}
                                    </button>
                                  </DisabledReason>
                                )
                              })}
                            </div>
                          </div>

                          {/* Smart sort: each mod's kind and the Steam "Required items". */}
                          <ItemInsights
                            modIds={inspectedGroup.mods.filter((m) => m.enabled).map((m) => m.id)}
                            insightOf={smartInsightOf}
                            requires={smart.insights.requirementsOf(inspectedGroup.wsId)}
                            health={smart.health.health}
                            canManage={canManageMods}
                            onApplyFix={applyHealthFixFromInspector}
                            onAddItem={openAddDialogFor}
                          />

                          {/* Groups this item belongs to, and its note. */}
                          <div className="space-y-1.5 border-t border-border/50 pt-3">
                            <div className="flex items-center justify-between gap-2">
                              <p className="label-micro">{tGroups('inspector.title')}</p>
                              <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setAddToGroup({ modIds: inspectedGroup.mods.map((m) => m.id), label: getGroupLabel(inspectedGroup) })}
                                  disabled={!canManageMods}
                                >
                                  <FolderPlus aria-hidden="true" />
                                  {tGroups('addTo.menuItem')}
                                </Button>
                              </DisabledReason>
                            </div>
                            {groupsOfWorkshop(inspectedGroup.wsId).length === 0 ? (
                              <p className="text-xs text-muted-foreground">{tGroups('inspector.none')}</p>
                            ) : (
                              <ul className="space-y-1">
                                {groupsOfWorkshop(inspectedGroup.wsId).map((group) => {
                                  const ids = inspectedGroup.mods.map((m) => m.id)
                                  const tooFew = removalLeavesTooFew(group, ids)
                                  return (
                                    <li key={group.id} className="flex items-center gap-2 text-xs">
                                      <GroupDot color={group.color} />
                                      <span className="min-w-0 flex-1 truncate text-foreground">{group.name}</span>
                                      <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : tooFew ? tGroups('removeFrom.tooFew') : null}>
                                        <button
                                          type="button"
                                          onClick={() => void handleRemoveFromGroup(group, ids)}
                                          disabled={!canManageMods || tooFew}
                                          aria-label={tGroups('removeFrom.menuItem', { name: group.name })}
                                          className="grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-muted/40 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
                                        >
                                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                                        </button>
                                      </DisabledReason>
                                    </li>
                                  )
                                })}
                              </ul>
                            )}
                          </div>
                          <div className="space-y-1.5 border-t border-border/50 pt-3">
                            <div className="flex items-center justify-between gap-2">
                              <p className="label-micro">{t('notes.inspectorTitle')}</p>
                              <Button variant="ghost" size="sm" onClick={() => setNoteEditor({ workshopId: inspectedGroup.wsId, name: getGroupLabel(inspectedGroup) })} disabled={!canManageMods && !notesStore.notes[inspectedGroup.wsId]}>
                                <StickyNote aria-hidden="true" />
                                {notesStore.notes[inspectedGroup.wsId] ? t('notes.editAction') : t('notes.addAction')}
                              </Button>
                            </div>
                            {notesStore.notes[inspectedGroup.wsId] ? (
                              <p className="whitespace-pre-wrap break-words text-xs text-foreground">{notesStore.notes[inspectedGroup.wsId].text}</p>
                            ) : (
                              <p className="text-xs text-muted-foreground">{t('notes.empty')}</p>
                            )}
                          </div>

                          {getGroupMissingDeps(inspectedGroup).length > 0 && (
                            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-2">
                              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                                <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                                {t('activeMods.missingRequiredIdsTitle')}
                              </div>
                              <div className="mt-1.5 space-y-2">
                                {getGroupMissingDeps(inspectedGroup).map(dep => {
                                  const key = getInspectorDepKey(inspectedGroup, dep)
                                  const searchOpen = depSearchOpen.has(key)
                                  const searchState = depSearchData[key]
                                  const adding = depAdding.includes(key)
                                  const added = depAddResults[key] === 'added'
                                  const errored = depAddResults[key] === 'error'

                                  return (
                                    <div key={dep} className="rounded border border-destructive/30 bg-background/40 p-1.5">
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() => toggleInspectorDepSearch(inspectedGroup, dep)}
                                          className="inline-flex items-center gap-1 rounded border border-destructive/30 bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/60"
                                          aria-expanded={searchOpen}
                                          aria-controls={`active-dep-search-${key}`}
                                          title={t('activeMods.searchWorkshopTooltip', { dep })}
                                        >
                                          <Search className="h-3 w-3" aria-hidden="true" />
                                          {dep}
                                        </button>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          className="h-7 px-2 text-xs sm:h-7"
                                          onClick={() => {
                                            if (!searchOpen) toggleInspectorDepSearch(inspectedGroup, dep)
                                            else runInspectorDepSearch(inspectedGroup, dep, true)
                                          }}
                                          disabled={searchState?.loading}
                                        >
                                          {searchState?.loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
                                          {t('activeMods.findInWorkshop')}
                                        </Button>
                                        {added && <span className="inline-flex items-center gap-1 text-xs font-medium text-success"><Check className="h-3 w-3" aria-hidden="true" /> {t('activeMods.added')}</span>}
                                        {errored && <span className="text-xs font-medium text-destructive">{t('activeMods.addFailed')}</span>}
                                      </div>

                                      {searchOpen && (
                                        <div id={`active-dep-search-${key}`} className="mt-2 space-y-2">
                                          {searchState?.loading ? (
                                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> {t('activeMods.searchingWorkshop', { dep })}
                                            </div>
                                          ) : searchState?.error ? (
                                            <div className="flex items-center justify-between gap-2 text-xs">
                                              <span className="break-words text-destructive">{t('activeMods.searchFailed', { error: searchState.error })}</span>
                                              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs sm:h-7" onClick={() => runInspectorDepSearch(inspectedGroup, dep, true)}>{t('activeMods.retry')}</Button>
                                            </div>
                                          ) : searchState && searchState.results.length === 0 ? (
                                            <div className="space-y-1 text-xs text-muted-foreground">
                                              <p>{t('activeMods.noMatchesFound')}</p>
                                              {searchState.searchUrl && (
                                                <a href={searchState.searchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                                                  <ExternalLink className="h-3 w-3" aria-hidden="true" /> {t('activeMods.openWorkshopSearch')}
                                                </a>
                                              )}
                                            </div>
                                          ) : searchState && searchState.results.length > 0 ? (
                                            <div className="space-y-1.5">
                                              <p className="text-xs text-muted-foreground">{t('activeMods.pickMatchingItem')}</p>
                                              {searchState.results.slice(0, 4).map((hit, hitIndex) => {
                                                const isBest = hit.matchType === 'exact-id' || hitIndex === 0
                                                return (
                                                  <div key={`${dep}-${hit.workshopId}-${hit.modId || ''}`} className={cn('rounded border px-2 py-1.5', isBest ? 'border-success/40 bg-success/5' : 'border-border/50 bg-card')}>
                                                    <div className="flex items-start justify-between gap-2">
                                                      <div className="min-w-0">
                                                        <div className="flex min-w-0 items-center gap-1.5">
                                                          <p className="truncate text-xs font-medium text-foreground" title={hit.modName}>{hit.modName}</p>
                                                          {isBest && (
                                                            <span className="shrink-0 rounded border border-success/40 bg-success/10 px-1 py-0 text-[10px] font-semibold text-foreground">
                                                              {t('activeMods.bestBadge')}
                                                            </span>
                                                          )}
                                                        </div>
                                                        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                                                          <span className="font-mono">WS {hit.workshopId}</span>
                                                          {hit.modId && <span className="font-mono">ID {hit.modId}</span>}
                                                          <span>{hit.source === 'local' ? t('activeMods.sourceLocal') : t('activeMods.sourceSteam')}</span>
                                                          {hit.matchType === 'exact-id' && <span className="text-success">{t('activeMods.exactIdBadge')}</span>}
                                                        </p>
                                                      </div>
                                                      <div className="flex shrink-0 items-center gap-1">
                                                        <a
                                                          href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${hit.workshopId}`}
                                                          target="_blank"
                                                          rel="noopener noreferrer"
                                                          className="rounded p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                                                          aria-label={t('activeMods.openOnSteamAria', { name: hit.modName })}
                                                        >
                                                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                                                        </a>
                                                        <Button
                                                          type="button"
                                                          variant="outline"
                                                          size="sm"
                                                          className="h-7 px-2 text-xs sm:h-7"
                                                          onClick={() => handleInspectorAddDep(hit, dep, key)}
                                                          disabled={adding || added || !canManageMods}
                                                        >
                                                          {adding ? <Loader2 className="animate-spin" aria-hidden="true" /> : added ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
                                                          {added ? t('activeMods.addedButton') : t('activeMods.addButton')}
                                                        </Button>
                                                      </div>
                                                    </div>
                                                  </div>
                                                )
                                              })}
                                              {searchState.searchUrl && (
                                                <a href={searchState.searchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                                                  <ExternalLink className="h-3 w-3" aria-hidden="true" /> {t('activeMods.openFullWorkshopSearch')}
                                                </a>
                                              )}
                                            </div>
                                          ) : null}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )}

                          {duplicateSets.filter((s) => s.workshopIds.includes(inspectedGroup.wsId)).map(duplicateNotice)}

                          <div className="border-t border-border/50 pt-3">
                            <DisabledReason reason={inspectedLockReason} className="w-full">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => { if (!canManageMods || inspectedLocked) return; setConfirmRemoveWorkshop({ wsId: inspectedGroup.wsId, knownModIds: inspectedGroup.mods.map(m => m.id) }) }}
                                disabled={!canManageMods || inspectedLocked}
                              >
                                <Trash2 aria-hidden="true" />
                                {t('activeMods.removeFromIni')}
                              </Button>
                            </DisabledReason>
                          </div>
                        </div>
                      </aside>
                    )}
                  </div>

                  {/* Mods= raw line — collapsed by default */}
                  <details className="group/raw border-t border-border/50 px-4 py-2">
                    <summary className="flex cursor-pointer select-none list-none items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                      <ChevronRight className="h-3 w-3 transition-transform group-open/raw:rotate-90 rtl:-scale-x-100" aria-hidden="true" />
                      <Trans i18nKey="activeMods.showRawModsLine" t={t} components={{ 1: <span className="font-mono" /> }} />
                    </summary>
                    <div className="mt-1.5 break-all font-mono text-xs leading-tight text-muted-foreground" title={`Mods=${iniConfig.modIds?.join(';') || ''}`}>
                      Mods={iniConfig.modIds?.join(';') || ''}
                    </div>
                  </details>
                </SectionCard>
              </>
            )
          })()}

          {/* ═══ LOAD ORDER ═══ */}
          {activeTab === 'order' && iniConfig?.configured && (
            <>
              <HealthSummaryCard health={smart.health.health} onReview={() => selectView('health')} />
              <ModGroupsPanel
                canManage={canManageMods}
                serverModIds={orderedModIds}
                modNames={modNamesRecord}
                savedModIds={iniConfig.modIds}
                orderDirty={hasModOrderChanged}
                orderSaving={savingModOrder}
                onOrderApplied={fetchData}
                createRequest={createGroupRequest}
                onCreatedFromRequest={() => setSelectedOrderIds(new Set())}
                store={groupsStore}
                requires={requiresMap}
                conflictsByGroup={conflictsByGroup}
                onShowConflicts={showGroupConflicts}
              />
              <SectionCard
                title={t('nav.order.label')}
                description={t('nav.order.hint')}
                icon={ListOrdered}
                flush
                actions={
                  orderedModIds.length > 0 ? (
                    <>
                      <Button
                        variant={showGroupBlocks ? 'secondary' : 'outline'}
                        size="sm"
                        aria-pressed={showGroupBlocks}
                        onClick={() => setShowGroupBlocks(!showGroupBlocks)}
                      >
                        <Layers aria-hidden="true" />
                        {/* Icon-only on a phone, so the card's title keeps its line. */}
                        <span className="sr-only sm:not-sr-only">{t('loadOrder.showGroups')}</span>
                      </Button>
                      <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleAutoSort}
                          disabled={savingModOrder || !!autoSortPreview || smart.smartSort.busy || !canManageMods}
                          aria-busy={smart.smartSort.busy}
                        >
                          {smart.smartSort.busy && !autoSortPreview ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Wand2 aria-hidden="true" />}
                          <span className="sr-only sm:not-sr-only">{t('loadOrder.autoSort')}</span>
                        </Button>
                      </DisabledReason>
                    </>
                  ) : undefined
                }
              >
                {orderedModIds.length === 0 ? (
                  <div className="p-6">
                    <EmptyState
                      type="noData"
                      compact
                      title={t('loadOrder.emptyTitle')}
                      description={t('loadOrder.emptyDesc')}
                      action={{ label: t('nav.active.label'), onClick: () => selectView('active'), variant: 'outline' }}
                    />
                  </div>
                ) : (
                  <>
                    <div className="space-y-3 border-b border-border/60 p-4">
                      {/* Without mods.manage the per-row move controls are
                          hidden, and while an Auto-sort proposal is open they
                          are disabled; a reason on each would be four
                          tooltips and dead tab stops per row, times 200+
                          rows, so it goes here once. (During Save Order they
                          are disabled too, and Save's spinner says why.) */}
                      <p className="text-xs text-muted-foreground">
                        {!canManageMods
                          ? t('permissions.noModsManage')
                          : autoSortPreview
                            ? t('loadOrder.previewLockHint')
                            : modManagerSearch.trim()
                              ? t('loadOrder.filteredHint', { query: modManagerSearch.trim() })
                              : t('loadOrder.dragHint')}
                      </p>
                      <Toolbar
                        search={{
                          value: modManagerSearch,
                          onChange: handleModManagerSearchChange,
                          placeholder: t('loadOrder.searchPlaceholder'),
                          ariaLabel: t('loadOrder.searchAria'),
                          slashToFocus: true,
                        }}
                      >
                        {canManageMods && selectedOrderIds.size > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('loadOrder.selectionAria')}>
                            <span className="text-xs tabular-nums text-muted-foreground">{t('loadOrder.selectedCount', { n: selectedOrderIds.size })}</span>
                            <DisabledReason reason={selectedOrderIds.size < 2 ? t('loadOrder.groupNeedsTwo') : null}>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  // In load order, not in the order they were ticked: that is the order the group starts with.
                                  setCreateGroupRequest({ modIds: orderSelectionModIds, nonce: Date.now() })
                                }}
                                disabled={selectedOrderIds.size < 2}
                              >
                                <Layers aria-hidden="true" />
                                {t('loadOrder.createGroupFromSelection')}
                              </Button>
                            </DisabledReason>
                            <Button variant="outline" size="sm" onClick={() => setAddToGroup({ modIds: orderSelectionModIds, clearSelection: 'order' })}>
                              <FolderPlus aria-hidden="true" />
                              {tGroups('addTo.selected')}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setSelectedOrderIds(new Set())}>
                              {t('loadOrder.clearSelection')}
                            </Button>
                          </div>
                        )}
                      </Toolbar>
                    </div>

                    {autoSortPreview && (
                      <div className="border-b border-border/60 p-4">
                        <SmartSortPreview
                          state={autoSortPreview}
                          busy={smart.smartSort.busy}
                          modNames={modIdNameMap}
                          groupsById={groupsStore.groupsById}
                          membership={groupsStore.membership}
                          tiered={smart.smartSort.tiered}
                          onTieredChange={(on) => smart.smartSort.setMode(on ? 'tiered' : 'minimal')}
                          steamStatus={autoSortPreview.plan.steamStatus}
                          steamRefreshing={smart.insights.refreshing}
                          onRefreshSteam={() => void smart.insights.refreshSteam().then(() => smart.smartSort.replan())}
                          onApply={applyAutoSort}
                          onCancel={closeSmartSort}
                        />
                      </div>
                    )}

                    <LoadOrderList
                      order={orderedModIds}
                      onOrderChange={setOrderedModIds}
                      canManage={canManageMods}
                      locked={loadOrderLocked}
                      filter={deferredModManagerSearch}
                      modNames={modIdNameMap}
                      modWorkshop={modIdWsMap}
                      notes={notesStore.notes}
                      groups={groupsStore.groups}
                      membership={groupsStore.membership}
                      conflictsByGroup={conflictsByGroup}
                      onShowGroupConflicts={showGroupConflicts}
                      showGroups={showGroupBlocks}
                      selected={selectedOrderIds}
                      onSelectedChange={(modId, checked) => setSelectedOrderIds((prev) => {
                        const next = new Set(prev)
                        if (checked) next.add(modId)
                        else next.delete(modId)
                        return next
                      })}
                      onOpenNote={(workshopId, label) => setNoteEditor({ workshopId, name: label })}
                      insightOf={smart.insights.insightOf}
                      movingIds={smart.movingIds}
                      onExplain={smart.explain}
                      rowMenu={smart.rowMenu}
                    />
                  </>
                )}
              </SectionCard>
              <PinnedOrderCard
                store={smart.rules}
                enabledModIds={new Set(orderedModIds)}
                modNames={modIdNameMap}
                canManage={canManageMods}
                onChanged={refreshAfterRuleChange}
              />
              <WhyHerePopover
                modId={smart.why?.modId ?? null}
                anchor={smart.why?.anchor ?? null}
                onClose={smart.closeWhy}
                order={orderedModIds}
                plan={smart.current.plan}
                fresh={smart.current.fresh}
                loading={smart.current.loading}
                insight={smart.why ? smart.insights.insightOf(smart.why.modId) : undefined}
                modNames={modIdNameMap}
                groupsById={groupsStore.groupsById}
                groups={groupsStore.groups}
                rules={smart.why ? smart.rules.rulesFor(smart.why.modId) : []}
                canManage={canManageMods}
                onPin={smart.openPin}
                onSortNow={canManageMods && !loadOrderLocked ? () => { smart.closeWhy(); handleAutoSort() } : null}
              />
              {smart.pin && (
                <OrderRuleDialog
                  open
                  onOpenChange={(open) => { if (!open) smart.closePin() }}
                  modId={smart.pin.modId}
                  direction={smart.pin.direction}
                  candidates={orderedModIds}
                  modNames={modIdNameMap}
                  store={smart.rules}
                  onAdded={refreshAfterRuleChange}
                />
              )}
            </>
          )}

          {/* ═══ HEALTH ═══ */}
          {activeTab === 'health' && iniConfig?.configured && (
            <HealthView
              store={smart.health}
              canManage={canManageMods}
              blockedReason={hasModOrderChanged ? tSmart('health.unsavedOrder') : savingModOrder ? tSmart('health.saving') : null}
              modName={(modId) => modIdNameMap.get(modId)}
              itemTitle={(workshopId) => trackedByWs.get(workshopId)?.name ?? undefined}
              onShowMod={showModFromHealth}
              onShowWorkshopItem={showWorkshopItem}
              onFixed={afterHealthFix}
              onRefreshSteam={() => void smart.insights.refreshSteam().then(() => smart.health.reload())}
              steamRefreshing={smart.insights.refreshing}
              fixEverything={fixEverythingButton}
            />
          )}

          {/* ═══ CONFLICTS ═══ */}
          {activeTab === 'conflicts' && (
            <ConflictsPanel
              conflicts={conflicts}
              focusDependencies={reviewUnresolved}
              focus={conflictsFocus}
              onClearFocus={() => setConflictsFocus(null)}
              conflictsLoading={conflictsLoading}
              conflictsError={conflictsError}
              conflictsStale={conflictsStale}
              lastScanTime={lastScanTime}
              scanConflicts={scanConflicts}
              scanProgress={scanProgress}
              scanCurrentMod={scanCurrentMod}
              scanModsScanned={scanModsScanned}
              scanTotalMods={scanTotalMods}
              streamConflicts={streamConflicts}
              fetchData={fetchData}
              busyRef={busyRef}
              savingModOrder={savingModOrder}
              promoteModOverOpponent={promoteModOverOpponent}
              toast={toast}
              depSearchOpen={depSearchOpen}
              setDepSearchOpen={setDepSearchOpen}
              depSearchData={depSearchData}
              setDepSearchData={setDepSearchData}
              depAdding={depAdding}
              setDepAdding={setDepAdding}
              depAddResults={depAddResults}
              setDepAddResults={setDepAddResults}
              smart={{ rules: smart.rules, canManage: canManageMods, onRuleAdded: refreshAfterRuleChange, onSortNow: openSmartSort }}
              fixEverything={fixEverythingButton}
            />
          )}
          {fixEverything.dialog}

          {/* ═══ COLLECTIONS ═══ */}
          {activeTab === 'collection' && (
            <>
              <SectionCard
                title={t('collectionView.importTitle')}
                description={t('collectionView.importDesc')}
                icon={Download}
                actions={
                  <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                    <Button size="sm" variant="outline" onClick={() => setCollectionDialogOpen(true)} disabled={!canManageMods}>
                      <Library aria-hidden="true" />
                      {t('statusBar.importCollection')}
                    </Button>
                  </DisabledReason>
                }
              />
              <WorkshopCollectionPanel />
            </>
          )}

          {/* ═══ PRESETS ═══ */}
          {activeTab === 'presets' && iniConfig?.configured && (
            <SectionCard
              title={t('nav.presets.label')}
              description={t('presetsTab.intro')}
              icon={Bookmark}
              flush
              actions={
                <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                  <Dialog open={savePresetOpen} onOpenChange={setSavePresetOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm" variant="outline" disabled={!iniConfig?.configured || !canManageMods}>
                        <Save aria-hidden="true" />
                        {t('presetsTab.saveCurrent')}
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('presetsTab.saveDialogTitle')}</DialogTitle>
                        <DialogDescription>
                          {t('presetsTab.saveDialogDesc')}
                        </DialogDescription>
                      </DialogHeader>
                      <DialogBody className="space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="presetName">{t('presetsTab.nameLabel')}</Label>
                          <Input
                            id="presetName"
                            value={presetName}
                            onChange={(e) => setPresetName(e.target.value)}
                            placeholder={t('presetsTab.namePlaceholder')}
                            maxLength={100}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="presetDesc">{t('presetsTab.descLabel')}</Label>
                          <Input
                            id="presetDesc"
                            value={presetDescription}
                            onChange={(e) => setPresetDescription(e.target.value)}
                            placeholder={t('presetsTab.descPlaceholder')}
                            maxLength={500}
                          />
                        </div>
                        {iniConfig?.configured && (
                          <div className="rounded-lg border border-border/60 bg-muted/40 p-3 text-sm text-muted-foreground">
                            {t('presetsTab.willSave', { workshopCount: iniConfig.workshopIds?.length || 0, modCount: iniConfig.modIds?.length || 0 })}
                          </div>
                        )}
                      </DialogBody>
                      <DialogFooter className="flex-col gap-2 sm:flex-row">
                        <Button variant="outline" onClick={() => setSavePresetOpen(false)} className="w-full sm:w-auto">
                          {t('presetsTab.cancel')}
                        </Button>
                        <Button onClick={handleSavePreset} disabled={savingPreset || !presetName.trim() || !canManageMods} className="w-full sm:w-auto">
                          {savingPreset && <Loader2 className="animate-spin" aria-hidden="true" />}
                          {t('presetsTab.savePreset')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </DisabledReason>
              }
            >
              {presetsLoading ? (
                <div className="space-y-2 p-4" role="status" aria-label={t('presetsTab.loadingPresets')}>
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : presets.length === 0 ? (
                <div className="p-6">
                  <EmptyState type="noData" compact title={t('presetsTab.emptyTitle')} description={t('presetsTab.emptyDesc')} />
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {presets.map((preset) => (
                    <div
                      key={preset.id}
                      className="flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-accent/20 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{preset.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {t('presetsTab.modsCount', { count: preset.workshop_ids?.length || 0 })} &bull; {preset.description || t('presetsTab.noDescription')}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('presetsTab.savedOn', { date: formatDate(preset.created_at) })}
                        </div>
                      </div>
                      <RowActions
                        ariaLabel={t('presetsTab.actionsAria', { name: preset.name })}
                        primary={
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setConfirmApplyPreset({ id: preset.id, name: preset.name, modCount: preset.workshop_ids?.length || 0 })}
                            disabled={applyingPreset === preset.id || !canManageMods}
                          >
                            {applyingPreset === preset.id ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                            {t('presetsTab.load')}
                          </Button>
                        }
                        items={[
                          {
                            label: t('presetsTab.deletePreset'),
                            icon: Trash2,
                            destructive: true,
                            onSelect: () => setConfirmDeletePreset({ id: preset.id, name: preset.name }),
                            disabled: !canManageMods,
                            reason: !canManageMods ? t('permissions.noModsManage') : undefined,
                          },
                        ]}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Preset apply confirmation */}
              <AlertDialog open={!!confirmApplyPreset} onOpenChange={(open) => { if (!open) setConfirmApplyPreset(null) }}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('presetsTab.applyDialogTitle', { name: confirmApplyPreset?.name })}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('presetsTab.applyDialogDesc', { count: confirmApplyPreset?.modCount || 0 })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('presetsTab.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        if (confirmApplyPreset) {
                          handleApplyPreset(confirmApplyPreset.id, confirmApplyPreset.name)
                          setConfirmApplyPreset(null)
                        }
                      }}
                      disabled={!canManageMods}
                    >
                      {t('presetsTab.applyPreset')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              {/* Preset delete confirmation */}
              <AlertDialog open={!!confirmDeletePreset} onOpenChange={(open) => { if (!open) setConfirmDeletePreset(null) }}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('presetsTab.deleteDialogTitle', { name: confirmDeletePreset?.name })}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('presetsTab.deleteDialogDesc')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('presetsTab.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => {
                        if (confirmDeletePreset) {
                          handleDeletePreset(confirmDeletePreset.id, confirmDeletePreset.name)
                          setConfirmDeletePreset(null)
                        }
                      }}
                      disabled={!canManageMods}
                    >
                      {t('presetsTab.deletePreset')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </SectionCard>
          )}

          {/* ═══ TOOLS ═══ */}
          {activeTab === 'tools' && iniConfig?.configured && (
            <>
              <SectionCard
                title={t('addModsTab.syncTitle')}
                description={t('addModsTab.syncDesc')}
                icon={RefreshCw}
                actions={
                  <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                    <Button onClick={handleSyncModIds} disabled={syncing || !canManageMods} size="sm" variant="outline">
                      <RefreshCw className={syncing ? 'animate-spin' : undefined} aria-hidden="true" />
                      {t('addModsTab.syncButton')}
                    </Button>
                  </DisabledReason>
                }
              />

              <SectionCard
                title={t('toolsTab.mapsTitle', { count: iniConfig?.maps?.length || 0 })}
                icon={MapIcon}
                actions={
                  <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        if (!canManageMods) return
                        try {
                          setRepairingMaps(true)
                          const result = await modsApi.repairMapEntries()
                          setMapRepairResult(result)
                        } catch (err) {
                          reportClientError('Map repair failed.', err)
                          setMapRepairResult({ removed: [], remaining: iniConfig?.maps || [], message: t('toolsTab.repairFailed') })
                        } finally {
                          setRepairingMaps(false)
                        }
                      }}
                      disabled={repairingMaps || !canManageMods}
                      // eslint-disable-next-line local/no-dead-disabled-title -- pure hint describing what the button does; the disabled-reason is already covered by the wrapping <DisabledReason> above. Triaged 2026-08-27.
                      title={t('toolsTab.repairTooltip')}
                    >
                      {repairingMaps ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Wrench aria-hidden="true" />}
                      {t('toolsTab.repair')}
                    </Button>
                  </DisabledReason>
                }
              >
                {mapRepairResult && (
                  <div className={cn('rounded-md border p-2 text-xs text-foreground', (mapRepairResult.removed.length > 0 || (mapRepairResult.added?.length ?? 0) > 0) ? 'border-warning/40 bg-warning/10' : 'border-success/40 bg-success/10')} role="status">
                    {mapRepairResult.message}
                  </div>
                )}
                <div className="flex flex-wrap gap-1">
                  {iniConfig.maps.map((map, i) => (
                    <Badge key={i} variant="secondary" className="max-w-[250px] truncate text-xs">
                      {map}
                    </Badge>
                  ))}
                </div>
              </SectionCard>

              <SectionCard title={t('toolsTab.workshopItemsTitle', { count: iniConfig.workshopIds?.length || 0 })} icon={Package}>
                <div className="flex max-h-[200px] flex-wrap gap-1 overflow-y-auto">
                  {iniConfig.workshopIds?.map((id, i) => (
                    <Badge key={i} variant="outline" className="max-w-[140px] truncate font-mono text-xs">
                      {id}
                    </Badge>
                  ))}
                </div>
                <div className="max-h-[80px] overflow-y-auto break-all rounded-md bg-muted/50 p-2 font-mono text-xs text-muted-foreground">
                  WorkshopItems={iniConfig.workshopIds?.join(';') || ''}
                </div>
              </SectionCard>

              <SectionCard title={t('toolsTab.notesTitle')} icon={Info}>
                <div className="space-y-3 text-sm text-muted-foreground">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('toolsTab.loadOrderMattersTitle')}</p>
                      <p className="text-xs">{t('toolsTab.loadOrderMattersDesc')}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <MapIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('toolsTab.mapModsCareTitle')}</p>
                      <p className="text-xs">{t('toolsTab.mapModsCareDesc')}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('toolsTab.syncAfterDownloadTitle')}</p>
                      <p className="text-xs">{t('toolsTab.syncAfterDownloadDesc')}</p>
                    </div>
                  </div>
                </div>
              </SectionCard>
            </>
          )}
        </SubNavLayout>
        </>
        )}

        {/* The one save affordance of the load order: sticks to the bottom
            while the order on screen differs from the saved one, from any view. */}
        {iniConfig?.configured && !permissionDenied && (
          <SaveBar
            dirty={hasModOrderChanged}
            saving={savingModOrder}
            onSave={() => void handleSaveModOrder()}
            onDiscard={() => { closeSmartSort(); setOrderedModIds(iniConfig.modIds) }}
            saveLabel={t('loadOrder.saveOrder')}
            disabledReason={!canManageMods ? t('permissions.noModsManage') : serverChangedSinceLoad ? t('toasts.serverChangedSinceLoadDesc') : undefined}
          />
        )}
      </div>

      {/* Import Collection Dialog */}
      <Dialog
        open={collectionDialogOpen}
        onOpenChange={(open) => {
          setCollectionDialogOpen(open)
          if (!open) {
            setShowCollectionAdvanced(false)
            setCollectionImported(false)
            setCollectionUrl('')
            setCollectionMods([])
          }
        }}
      >
        {/* Only the DialogBody scrolls, under DialogContent's own bound; it is
            a flex column whose mod list keeps its height cap on a tall window
            but shrinks (never below 6rem) to the room left on a short one,
            so the list is the one scroller. */}
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('collectionDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('collectionDialog.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <div>
              <div className="flex items-center gap-1.5">
                <Label htmlFor="collection-url-input">{t('collectionDialog.urlLabel')}</Label>
                <HelpTip label={t('collectionDialog.urlLabel')}>{t('collectionDialog.urlHelp')}</HelpTip>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="collection-url-input"
                  value={collectionUrl}
                  onChange={(e) => setCollectionUrl(e.target.value)}
                  placeholder={t('collectionDialog.urlPlaceholder')}
                  maxLength={200}
                  autoFocus
                />
                <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
                  <Button
                    onClick={handleImportCollection}
                    disabled={importingCollection || !canManageMods}
                    className="w-full sm:w-auto"
                    aria-label={t('collectionDialog.fetchAria')}
                  >
                    {importingCollection ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                  </Button>
                </DisabledReason>
              </div>
            </div>

            {collectionImported && collectionMods.length === 0 && !importingCollection && (
              <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-foreground">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                {t('collectionDialog.noModsFound')}
              </div>
            )}

            {collectionMods.length > 0 && (
              <div className="flex min-h-0 flex-col gap-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label>{t('collectionDialog.foundMods', { count: collectionMods.length })}</Label>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setShowCollectionAdvanced(!showCollectionAdvanced)}
                    >
                      {showCollectionAdvanced ? t('collectionDialog.hideAdvanced') : t('collectionDialog.editIdsAndMaps')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setCollectionMods(prev => prev.map(m => ({ ...m, selected: true })))}
                    >
                      {t('collectionDialog.selectAll')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setCollectionMods(prev => prev.map(m => ({ ...m, selected: false })))}
                    >
                      {t('collectionDialog.deselectAll')}
                    </Button>
                  </div>
                </div>
                <div className="min-h-24 max-h-[min(48vh,22rem)] overflow-y-auto rounded-lg border p-2 sm:max-h-[min(52vh,24rem)]">
                  <div className="space-y-2">
                    {collectionMods.map((mod) => {
                      const alreadyInstalled = iniConfig?.workshopIds?.includes(mod.workshopId)
                      return (
                        <div
                          key={mod.workshopId}
                          className={cn('flex items-start gap-3 rounded-lg border p-3 transition-colors', mod.selected ? 'border-primary/30 bg-primary/10' : 'bg-card/60 hover:bg-accent/20')}
                        >
                          <Checkbox
                            checked={mod.selected}
                            onCheckedChange={() => toggleModSelection(mod.workshopId)}
                            aria-label={t('collectionDialog.selectAria', { name: mod.name })}
                          />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium" title={mod.name}>{mod.name}</span>
                              {alreadyInstalled && (
                                <Badge variant="outline" className="text-xs text-muted-foreground">
                                  {t('collectionDialog.installedBadge')}
                                </Badge>
                              )}
                              {mod.isMap && (
                                <Badge variant="secondary" className="text-xs">
                                  <MapIcon className="me-1 h-3 w-3" />
                                  {t('collectionDialog.mapBadge')}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {t('collectionDialog.idLabel', { id: mod.workshopId })}
                            </p>
                            {mod.selected && showCollectionAdvanced && (
                              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div>
                                  <Label className="text-xs" htmlFor={`collection-mod-id-${mod.workshopId}`}>{t('collectionDialog.modIdLabel')}</Label>
                                  <Input
                                    id={`collection-mod-id-${mod.workshopId}`}
                                    value={mod.modId || ''}
                                    onChange={(e) => updateModId(mod.workshopId, e.target.value)}
                                    placeholder={t('collectionDialog.modIdPlaceholder')}
                                    maxLength={200}
                                    className="h-7 text-xs"
                                  />
                                </div>
                                {mod.isMap && (
                                  <div>
                                    <Label className="text-xs" htmlFor={`collection-map-folder-${mod.workshopId}`}>{t('collectionDialog.mapFolderLabel')}</Label>
                                    <Input
                                      id={`collection-map-folder-${mod.workshopId}`}
                                      value={mod.mapFolder || ''}
                                      onChange={(e) => updateMapFolder(mod.workshopId, e.target.value)}
                                      placeholder={t('collectionDialog.mapFolderPlaceholder')}
                                      maxLength={200}
                                      className="h-7 text-xs"
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          <Button
                            size="iconDense"
                            variant="ghost"
                            onClick={() => openWorkshopPage(mod.workshopId)}
                            aria-label={t('collectionDialog.openWorkshopAria')}
                          >
                            <ExternalLink className="h-3 w-3" />
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCollectionDialogOpen(false)}>
              {t('collectionDialog.cancel')}
            </Button>
            <DisabledReason reason={!canManageMods ? t('permissions.noModsManage') : null}>
              <Button
                onClick={handleAddCollectionMods}
                disabled={loading || selectedCollectionCount === 0 || !canManageMods || pendingAddServerChanged}
              >
                {loading ? t('collectionDialog.adding') : t('collectionDialog.addToServer', { count: selectedCollectionCount })}
              </Button>
            </DisabledReason>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Single Mod Dialog - with Multi-ID support */}
      <Dialog open={advancedAddOpen} onOpenChange={setAdvancedAddDialogOpen}>
        {/* Only the DialogBody scrolls, under DialogContent's own bound, and
            the ID list flows in it. */}
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('addModDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('addModDialog.descPrefix')}{' '}
              <button
                type="button"
                className="rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                onClick={() => { setAdvancedAddDialogOpen(false); setCollectionDialogOpen(true) }}
              >
                {t('addModDialog.importCollectionLink')}
              </button>.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {/* Input section */}
            <div className="space-y-2">
              <Label htmlFor="advanced-mod-input" className="sr-only">{t('addModDialog.inputLabel')}</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="advanced-mod-input"
                  value={advancedModInput}
                  onChange={(e) => handleModInputChange(e.target.value)}
                  placeholder={t('addModDialog.inputPlaceholder')}
                  onKeyDown={(e) => e.key === 'Enter' && !discoveringMod && handleDiscoverMod()}
                  className="font-mono text-sm"
                  maxLength={200}
                />
                <Button
                  id="discover-mod-btn"
                  onClick={handleDiscoverMod}
                  disabled={discoveringMod || !advancedModInput.trim() || !canManageMods}
                  variant="secondary"
                  className="w-full shrink-0 sm:w-auto"
                >
                  {discoveringMod ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Search className="me-1 h-4 w-4" />
                      {t('addModDialog.discover')}
                    </>
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('addModDialog.example')}
              </p>
            </div>

            {/* Loading skeleton */}
            {discoveringMod && (
              <p className="text-xs text-muted-foreground" role="status">{t('addModDialog.discoveringHint')}</p>
            )}
            {discoveringMod && (
              <div className="animate-pulse space-y-3 rounded-lg border bg-muted/30 p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-3/4 rounded bg-muted" />
                    <div className="h-3 w-1/2 rounded bg-muted" />
                  </div>
                  <div className="h-5 w-16 rounded bg-muted" />
                </div>
                <div className="space-y-1.5">
                  <div className="h-8 rounded bg-muted" />
                  <div className="h-8 rounded bg-muted" />
                </div>
              </div>
            )}

            {/* Discovered mod info */}
            {discoveredMod && !discoveringMod && (
              <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                {/* Mod header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h4 className="truncate text-sm font-medium" title={discoveredMod.name}>
                      {discoveredMod.name}
                    </h4>
                    <div className="mt-0.5 flex items-center gap-2">
                      <code className="font-mono text-xs text-muted-foreground">
                        {discoveredMod.workshopId}
                      </code>
                      <button
                        onClick={() => window.open(`https://steamcommunity.com/sharedfiles/filedetails/?id=${discoveredMod.workshopId}`, '_blank', 'noopener,noreferrer')}
                        className="flex items-center gap-0.5 rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {t('addModDialog.view')}
                      </button>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {discoveredMod.isMap && (
                      <Badge variant="secondary" className="h-5 text-xs">
                        <MapIcon className="me-1 h-3 w-3" />
                        {t('addModDialog.mapBadge')}
                      </Badge>
                    )}
                    {discoveredMod.isDownloaded ? (
                      <Badge variant="success" className="h-5 text-xs">
                        <CheckCircle className="me-1 h-3 w-3" />
                        {t('addModDialog.downloadedBadge')}
                      </Badge>
                    ) : (
                      <Badge variant="warning" className="h-5 text-xs">
                        <Download className="me-1 h-3 w-3" />
                        {t('addModDialog.notDownloadedBadge')}
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Already added warning */}
                {discoveredMod.isAlreadyAdded && (
                  <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 p-2 text-xs text-foreground">
                    <Info className="h-4 w-4 shrink-0 text-primary" />
                    <span>{t('addModDialog.alreadyAdded')}</span>
                  </div>
                )}

                {/* Mod IDs selection */}
                {discoveredMod.modIds.length > 0 ? (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label className="text-xs font-medium">
                          {discoveredMod.hasMultipleModIds
                            ? t('addModDialog.modIdsSelectedLabel', { selected: selectedModIds.size, total: discoveredMod.modIds.length })
                            : t('addModDialog.modIdLabel')}
                        </Label>
                        <HelpTip
                          label={
                            discoveredMod.hasMultipleModIds
                              ? t('addModDialog.modIdsSelectedLabel', { selected: selectedModIds.size, total: discoveredMod.modIds.length })
                              : t('addModDialog.modIdLabel')
                          }
                        >
                          {t('addModDialog.modIdsHelp')}
                        </HelpTip>
                      </div>
                      {discoveredMod.hasMultipleModIds && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-xs"
                          onClick={() => setShowAdvancedIdSelection(!showAdvancedIdSelection)}
                        >
                          {showAdvancedIdSelection ? t('addModDialog.hide') : t('addModDialog.reviewIds')}
                        </Button>
                      )}
                    </div>

                    {discoveredMod.hasMultipleModIds && !showAdvancedIdSelection ? (
                      <p className="text-xs text-muted-foreground">
                        {t('addModDialog.preSelectedHint')}
                      </p>
                    ) : (
                      <>
                        {discoveredMod.hasMultipleModIds && (
                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-xs"
                              onClick={() => {
                                const newIds = discoveredMod.modIds.filter(
                                  id => !discoveredMod.alreadyConfigured?.includes(id)
                                )
                                setSelectedModIds(new Set(newIds))
                              }}
                            >
                              {t('addModDialog.selectNew')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-xs"
                              onClick={() => {
                                if (selectedModIds.size === discoveredMod.modIds.length) {
                                  setSelectedModIds(new Set())
                                } else {
                                  setSelectedModIds(new Set(discoveredMod.modIds))
                                }
                              }}
                            >
                              {selectedModIds.size === discoveredMod.modIds.length ? t('addModDialog.none') : t('addModDialog.all')}
                            </Button>
                          </div>
                        )}
                        <div className="space-y-1 rounded-lg border border-border/50 bg-background/50 p-1.5">
                          {discoveredMod.modIds.map((modId) => {
                            const isConfigured = discoveredMod.alreadyConfigured?.includes(modId)
                            return (
                              <div
                                key={modId}
                                role="button"
                                tabIndex={0}
                                aria-pressed={selectedModIds.has(modId)}
                                className={cn(
                                  'flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
                                  selectedModIds.has(modId)
                                    ? 'bg-primary/10 ring-1 ring-inset ring-primary/40'
                                    : isConfigured
                                      ? 'bg-muted/30 opacity-70'
                                      : 'hover:bg-muted/40',
                                )}
                                onClick={() => toggleModIdSelection(modId)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    toggleModIdSelection(modId)
                                  }
                                }}
                              >
                                <Checkbox
                                  checked={selectedModIds.has(modId)}
                                  onCheckedChange={() => toggleModIdSelection(modId)}
                                  aria-label={t('addModDialog.selectModIdAria', { id: modId })}
                                />
                                <code className="flex-1 truncate font-mono text-xs" title={modId}>
                                  {modId}
                                </code>
                                {isConfigured && (
                                  <Badge variant="outline" className="h-5 shrink-0 text-xs text-muted-foreground">
                                    {t('addModDialog.existsBadge')}
                                  </Badge>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                    <div>
                      <p className="font-medium text-warning">
                        {discoveredMod.isDownloaded
                          ? t('addModDialog.noModInfoTitle')
                          : t('addModDialog.notDownloadedTitle')}
                      </p>
                      <p className="mt-0.5 text-muted-foreground">
                        {discoveredMod.isDownloaded
                          ? t('addModDialog.unconventionalStructure')
                          : t('addModDialog.addAndSyncLater')}
                      </p>
                    </div>
                  </div>
                )}

                {/* Map folders info */}
                {discoveredMod.mapFolders.length > 0 && (
                  <div className="flex items-start gap-2 text-xs">
                    <MapIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div>
                      <span className="font-medium">{t('addModDialog.mapFoldersWillBeAdded')}</span>
                      <div className="mt-0.5 text-muted-foreground [overflow-wrap:anywhere]">
                        {discoveredMod.mapFolders.join(', ')}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </DialogBody>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              onClick={() => setAdvancedAddDialogOpen(false)}
              className="w-full sm:order-1 sm:w-auto"
            >
              {t('addModDialog.cancel')}
            </Button>
            <Button
              onClick={handleAddModAdvanced}
              disabled={loading || !discoveredMod || discoveringMod || !canManageMods || pendingAddServerChanged}
              className="w-full sm:order-2 sm:w-auto"
            >
              {loading ? (
                <>
                  <RefreshCw className="me-2 h-4 w-4 animate-spin" />
                  {t('addModDialog.adding')}
                </>
              ) : discoveredMod?.modIds.length ? (
                selectedModIds.size > 0
                  ? t('addModDialog.addModIds', { count: selectedModIds.size })
                  : t('addModDialog.addWorkshopIdOnly')
              ) : discoveredMod ? (
                t('addModDialog.addWorkshopId')
              ) : (
                t('addModDialog.discoverFirst')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Auto-restart settings: the on/off switch (the status bar's chip
          opens this dialog) and how the restart behaves. */}
      <Dialog open={restartSettingsOpen} onOpenChange={setRestartSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('restartSettingsDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('restartSettingsDialog.description')}
            </DialogDescription>
          </DialogHeader>
          {/* DialogBody: with "Delay if players online" on, a landscape phone
              scrolled Save Settings below the fold. */}
          <DialogBody className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 p-3">
              <div className="space-y-1">
                <Label htmlFor="restart-auto-enabled">{t('statusBar.autoRestart')}</Label>
                <p className="text-xs text-muted-foreground">{t('restartSettingsDialog.autoRestartHint')}</p>
              </div>
              <Switch
                id="restart-auto-enabled"
                checked={status?.autoRestartEnabled || false}
                onCheckedChange={handleToggleAutoRestart}
                disabled={loading || !canManageMods}
                aria-label={t('statusBar.autoRestartAria')}
              />
            </div>

            <div>
              <Label htmlFor="restart-warning-minutes">{t('restartSettingsDialog.warningTimeLabel')}</Label>
              <NumberInput
                id="restart-warning-minutes"
                min={0}
                max={30}
                value={restartWarningMinutes}
                onChange={setRestartWarningMinutes}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('restartSettingsDialog.warningTimeHint')}
              </p>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 p-3">
              <div className="space-y-1">
                <Label htmlFor="restart-delay-players">{t('restartSettingsDialog.delayIfPlayersLabel')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('restartSettingsDialog.delayIfPlayersHint')}
                </p>
              </div>
              <Switch
                id="restart-delay-players"
                checked={delayIfPlayersOnline}
                onCheckedChange={setDelayIfPlayersOnline}
              />
            </div>

            {delayIfPlayersOnline && (
              <div>
                <Label htmlFor="restart-max-delay">{t('restartSettingsDialog.maxDelayLabel')}</Label>
                <NumberInput
                  id="restart-max-delay"
                  min={5}
                  max={120}
                  value={maxDelayMinutes}
                  onChange={setMaxDelayMinutes}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('restartSettingsDialog.maxDelayHint')}
                </p>
              </div>
            )}
          </DialogBody>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => setRestartSettingsOpen(false)} className="w-full sm:w-auto">
              {t('restartSettingsDialog.cancel')}
            </Button>
            <Button onClick={handleSaveRestartSettings} disabled={loading || !canManageMods} className="w-full sm:w-auto">
              {loading ? t('restartSettingsDialog.saving') : t('restartSettingsDialog.saveSettings')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Always mounted (it used to live inside the pending-restart banner, so
          "Fix path" had nothing to open for anyone not in that state). */}
      <FolderBrowser
        open={workshopBrowserOpen}
        onOpenChange={setWorkshopBrowserOpen}
        onSelect={handleWorkshopFolderSelected}
        initialPath={workshopBrowserInitialPath}
        title={t('folderBrowser.title')}
      />

      {/* Single mod remove confirmation. Several rows open it (Installed, the
          "removed from Workshop" alert, Active's menu, Deactivated), so it
          names the target. */}
      <AlertDialog open={!!confirmRemoveMod} onOpenChange={(open) => { if (!open) setConfirmRemoveMod(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeModDialog.title', { name: confirmRemoveMod?.label || confirmRemoveMod?.wsId || '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('removeModDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('removeModDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (confirmRemoveMod) handleRemoveMod(confirmRemoveMod.wsId); setConfirmRemoveMod(null) }}
              disabled={!canManageMods}
            >
              {t('removeModDialog.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk remove confirmation */}
      <AlertDialog open={confirmBulkRemove} onOpenChange={setConfirmBulkRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('bulkRemoveDialog.title', { count: selectedMods.size })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('bulkRemoveDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('bulkRemoveDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { handleBulkRemove(); setConfirmBulkRemove(false) }}
              disabled={!canManageMods}
            >
              {t('bulkRemoveDialog.remove', { count: selectedMods.size })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Workshop item remove confirmation (Active on server) */}
      <AlertDialog open={!!confirmRemoveWorkshop} onOpenChange={(open) => { if (!open) setConfirmRemoveWorkshop(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('activeMods.removeWorkshopDialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('activeMods.removeWorkshopDialogDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('activeMods.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmedRemoveWorkshop}
              disabled={!canManageMods}
            >
              {t('activeMods.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Group dialog opened outside the Load order panel (Groups view, a
          suggestion, "New group…" from a row's picker). */}
      {groupEditor && (
        <ModGroupDialog
          group={groupEditor.group}
          initialModIds={groupEditor.initialModIds}
          initialName={groupEditor.initialName}
          placement={groupEditor.group ? groupsStore.placements[groupEditor.group.id] ?? null : null}
          serverModIds={orderedModIds}
          modNames={modNamesRecord}
          requires={requiresMap}
          onClose={() => setGroupEditor(null)}
          onSubmit={handleSaveGroup}
        />
      )}

      {addToGroup && (
        <AddToGroupDialog
          modIds={addToGroup.modIds}
          label={addToGroup.label}
          groups={groupsStore.groups}
          onAdd={handleAddToGroup}
          onCreateNew={() => {
            // In load order; picked mods that are not enabled (not in it) follow.
            const inOrder = orderedModIds.filter((id) => addToGroup.modIds.includes(id))
            const modIds = [...new Set([...inOrder, ...addToGroup.modIds])]
            setGroupEditor({ group: null, initialModIds: modIds })
            setAddToGroup(null)
          }}
          onClose={() => setAddToGroup(null)}
        />
      )}

      {noteEditor && (
        <ModNoteDialog
          name={noteEditor.name}
          note={notesStore.notes[noteEditor.workshopId]}
          canEdit={canManageMods}
          onSave={handleSaveNote}
          onClose={() => setNoteEditor(null)}
        />
      )}
    </TooltipProvider>
  )
}
