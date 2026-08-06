import { useTranslation } from 'react-i18next';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useSocket } from '@/contexts/SocketContext'
import { useConfirm } from '@/contexts/ConfirmContext'
import { usePageShortcut } from '../hooks/useKeyboardShortcuts'
import { copyText } from '@/lib/utils'
import {
  Package,
  RefreshCw,
  Plus,
  Trash2,
  ExternalLink,
  AlertTriangle,
  AlertCircle,
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
  GripVertical,
  MoreVertical,
  Shield,
  ShieldAlert,
  FileWarning,
  Wrench,
  Network,
  GitBranch,
  PlusCircle,
  X,
  EyeOff,
  Eye,
  ArrowRight,
  Wand2,
} from 'lucide-react'
import { ConflictScanResult, ScanStreamModScanned, ScanStreamConflictFound } from '@/types'
import { FileDiffViewer } from '@/components/FileDiffViewer'
import { WorkshopCollectionPanel } from '@/components/WorkshopCollectionPanel'
import { getAccessToken } from '@/lib/authToken'
import { isDemoMode } from '@/lib/demo'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { reportClientError, reportClientWarning } from '@/lib/client-errors'
import {
  Dialog,
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { modsApi } from '@/lib/api'
import { buildRequiresMap, computeAutoSortedOrder, createRequirementResolver, type AutoSortResult } from '@/lib/modLoadOrder'
import { EmptyState } from '@/components/EmptyState'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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

interface TrackedMod {
  id: number
  workshop_id: string
  name: string
  last_updated: string
  last_checked: string | null
  update_available: number
  created_at: string
  active?: boolean
}

interface ModStatus {
  totalModsTracked: number
  totalModsInWorkshop: number
  updatesAvailable: number
  lastCheck: string | null
  lastUpdateDetected: string | null
  autoRestartEnabled: boolean
  running: boolean
  workshopAcfConfigured: boolean
  workshopAcfPath: string | null
  checkInterval: number
  modsNeedingUpdate: Array<{
    workshopId: string
    name: string
    localTimestamp: string
    latestTimestamp: string
  }>
  // Restart options
  restartWarningMinutes: number
  delayIfPlayersOnline: boolean
  maxDelayMinutes: number
  pendingRestart: boolean
}

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
  workshopModMap?: Record<string, Array<{ id: string; name: string; enabled: boolean; require?: string[] }>>
}

// ── Conflict scanner constants (hoisted to avoid re-creation in render) ──
const CONFLICT_FILE_LIMIT = 12

// ── Types used in Active Mods sub-tab (hoisted for memoization) ──
type ModEntry = { id: string; name: string; enabled: boolean; require?: string[] }
type WsGroup = { wsId: string; mods: ModEntry[]; allEnabled: boolean; someEnabled: boolean }

// ── useState wrapper that persists value to localStorage under a stable key. ──
// Used so the conflict tab remembers the user's filter choices across reloads.
function useLocalStorageState<T>(key: string, defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) return defaultValue
      return JSON.parse(raw) as T
    } catch { return defaultValue }
  })
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota or disabled — ignore */ }
  }, [key, value])
  return [value, setValue]
}

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

export default function Mods() {
  const { t } = useTranslation('mods');
  
  
  
  
  const demoMode = isDemoMode()
  const [mods, setMods] = useState<TrackedMod[]>([])
  const [status, setStatus] = useState<ModStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const { toast } = useToast()
  const confirm = useConfirm()

  // Search and filters
  const [searchQuery, setSearchQuery] = useState('')
  const [deferredSearchQuery, setDeferredSearchQuery] = useState('')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [showUpdatesOnly, setShowUpdatesOnly] = useState(false)
  const [selectedMods, setSelectedMods] = useState<Set<string>>(new Set())

  // Disabled-mods reveal (mods downloaded into the Steam workshop folder but
  // not present in the server INI's WorkshopItems= list). Off by default to
  // keep the page focused on what's actually loaded by the server.
  const [showDisabled, setShowDisabled] = useState(false)
  const [disabledMods, setDisabledMods] = useState<Array<{ workshop_id: string; name: string }>>([])
  const [disabledLoading, setDisabledLoading] = useState(false)
  const [enablingId, setEnablingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Ctrl+K = focus search
  usePageShortcut('k', () => { searchInputRef.current?.focus() }, { ctrl: true })

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
  const [modsToInstall, setModsToInstall] = useState<CollectionMod[]>([])
  const [orderedModIds, setOrderedModIds] = useState<string[]>([])
  const [selectedActiveWsId, setSelectedActiveWsId] = useState<string | null>(null)
  const [savingModOrder, setSavingModOrder] = useState(false)
  const [autoSortPreview, setAutoSortPreview] = useState<AutoSortResult | null>(null)
  const [draggedModIndex, setDraggedModIndex] = useState<number | null>(null)
  // Expand/collapse states
  const [repairingMaps, setRepairingMaps] = useState(false)
  const [mapRepairResult, setMapRepairResult] = useState<{ removed: string[]; added?: string[]; remaining: string[]; message: string } | null>(null)
  const [confirmRemoveMod, setConfirmRemoveMod] = useState<string | null>(null) // workshopId to confirm single remove
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false)
  const [ignoredMods, setIgnoredMods] = useState<Array<{ workshop_id: string; name: string | null; ignored_at: string }>>([])
  const [ignoredModsOpen, setIgnoredModsOpen] = useState(false)
  // Conflict pairs the user has explicitly dismissed as false positives.
  const [ignoredPairs, setIgnoredPairs] = useState<Array<{ mod_a: string; mod_b: string; reason?: string | null }>>([])
  const [confirmRemoveWorkshop, setConfirmRemoveWorkshop] = useState<{ wsId: string; knownModIds: string[] } | null>(null) // wsId for config tab remove
  const [deduplicating, setDeduplicating] = useState(false)
  const [deduplicateResult, setDeduplicateResult] = useState<string | null>(null)
  const [filterMultiId, setFilterMultiId] = useState(true)
  const [modManagerSearch, setModManagerSearch] = useState('')
  const [deferredModManagerSearch, setDeferredModManagerSearch] = useState('')
  const modSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [configSubTab, setConfigSubTab] = useState<'active' | 'order' | 'add' | 'presets' | 'tools'>('active')
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
  const [openPairs, setOpenPairs] = useState<string[]>([])
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

  // Inner sub-tab within Conflicts: 'network' or 'dependencies'
  const [conflictSubTab, setConflictSubTab] = useLocalStorageState<'network' | 'dependencies'>('zcp:mods:conflicts:subTab', 'network')
  // Severity filter for pairs list: 'all' | 'high' | 'medium' | 'low'
  const [pairSeverityFilter, setPairSeverityFilter] = useLocalStorageState<'all' | 'real' | 'high' | 'medium' | 'low'>('zcp:mods:conflicts:severity', 'real')
  const [groupByWinner, setGroupByWinner] = useLocalStorageState<boolean>('zcp:mods:conflicts:groupByWinner', true)
  const [pairSearchQuery, setPairSearchQuery] = useLocalStorageState<string>('zcp:mods:conflicts:search', '')
  const [showAllTopMods, setShowAllTopMods] = useState<boolean>(false)
  // Graph filter state (used for pair filtering in the conflict list)
  const [graphFilterMod, setGraphFilterMod] = useState<string | null>(null)

  // Track which conflict pairs have "show all files" expanded
  const [expandedFilePairs, setExpandedFilePairs] = useState<Set<string>>(new Set())
  // Mod-details drawer — when set, opens a Dialog showing every conflict that mod is in.
  const [modDetailsId, setModDetailsId] = useState<string | null>(null)
  // Missing deps state
  const [depAdding, setDepAdding] = useState<string[]>([])
  const [depAddResults, setDepAddResults] = useState<Record<string, 'added' | 'error'>>({})
  const [fixingAllDeps, setFixingAllDeps] = useState(false)
  // Inline Workshop search per unresolved dep row (key → state)
  type DepSearchHit = {
    workshopId: string
    modId?: string
    modName: string
    description?: string
    subscriberCount?: number
    source: 'local' | 'steam'
    isDownloaded: boolean
    matchedVariant?: string
    relevance?: number
    matchType?: string
  }
  type DepSearchState = { loading: boolean; results: DepSearchHit[]; error: string | null; searchUrl: string | null; variantsTried?: string[]; steamSearchEnabled?: boolean }
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
    const currentSnapshot = JSON.stringify({
      ws: iniConfig?.workshopIds?.slice().sort() || [],
      mods: iniConfig?.modIds?.slice().sort() || []
    })
    return currentSnapshot !== scanIniSnapshot
  }, [conflicts, scanIniSnapshot, iniConfig?.workshopIds, iniConfig?.modIds])

  // Track if auto-discover is pending (moved here for cleanup)
  const autoDiscoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAutoDiscoverIdRef = useRef<string | null>(null)

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
        message: `Duplicate mod IDs found: ${duplicates.map(([id]) => id).join(', ')}`,
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
        severity: 'warning',
        message: `${workshopCount} workshop items configured but no mod IDs. Run "Sync Mod IDs" after downloading mods.`,
      })
    }

    return conflicts
  }, [iniConfig])

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

  const fetchData = useCallback(async () => {
    setFetchError(null)
    try {
      // Use allSettled so one failure doesn't break everything
      const results = await Promise.allSettled([
        modsApi.getTrackedMods(),
        modsApi.getStatus(),
        modsApi.getCurrentConfig(),
        modsApi.getIgnoredMods(),
        modsApi.getIgnoredModPairs()
      ])

      // Extract successful results
      if (results[0].status === 'fulfilled') {
        setMods(results[0].value.mods || [])
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
        // Initialize ordered mod IDs when iniConfig is loaded
        if (results[2].value?.modIds) {
          setOrderedModIds(results[2].value.modIds)
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
          setFetchError(t('logic.failedToLoadModData'))
        }
      }
    } catch (error) {
      reportClientError(t('logic.failedToFetchModsData'), error)
      setFetchError(t('logic.failedToLoadModData'))
    }
    // After any tracked-mod refresh, re-check the collection chip in the
    // background. The status hook short-circuits if no collection is wired,
    // so this is a no-op for users who don't use the feature.
    fetchCollectionStatusRef.current?.().catch(() => {})
  }, [t])

  // Fetch mods that exist on disk but are NOT in the server INI.
  // Lazy: only called when the user opens the "Show disabled" panel.
  const fetchDisabled = useCallback(async () => {
    setDisabledLoading(true)
    try {
      const result = await modsApi.listDiskOnly()
      setDisabledMods(result.mods || [])
    } catch (error) {
      reportClientError(t('logic.failedToFetchDisabledMods'), error)
    } finally {
      setDisabledLoading(false)
    }
  }, [t])

  const handleEnableDiskMod = useCallback(async (workshopId: string) => {
    if (enablingId) return
    setEnablingId(workshopId)
    try {
      const r = await modsApi.enableDiskMod(workshopId)
      toast({
        title: t('toast.modEnabled'),
        description: t('toast.modEnabledToIniDesc', { count: r.modIdsAdded }),
      })
      // Refresh both lists so the row moves from disabled → tracked.
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: t('toast.enableFailed'),
        description: getUserErrorMessage(error, t('toast.enableFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setEnablingId(null)
    }
  }, [enablingId, t, toast, fetchData, fetchDisabled])

  // Delete a single mod's files from disk (and strip it from the INI).
  // Used by the "Disabled mods on disk" and "Ignored mods" panels.
  const handleDeleteDiskMod = useCallback(async (workshopId: string, modName?: string) => {
    if (deletingId) return
    const label = modName ? `"${modName}" (${workshopId})` : workshopId
    const ok = await confirm({
      title: t('toast.deleteFromDiskConfirm'),
      description: t('toast.deleteFromDiskConfirmDesc', { label }),
      confirmLabel: t('toast.delete'),
    })
    if (!ok) {
      return
    }
    setDeletingId(workshopId)
    try {
      const r = await modsApi.deleteDiskMod(workshopId)
      toast({
        title: t('toast.modDeleted'),
        description: r.deletedFromDisk
          ? `Removed from disk (${r.modIdsStripped} mod ID${r.modIdsStripped === 1 ? '' : 's'} stripped from INI).`
          : t('toast.folderAlreadyMissingDesc'),
      })
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: t('toast.deleteFailed'),
        description: getUserErrorMessage(error, t('toast.deleteFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setDeletingId(null)
    }
  }, [confirm, deletingId, t, toast, fetchData, fetchDisabled])

  // Bulk delete all currently shown disabled-on-disk mods.
  const handleDeleteAllDisabled = useCallback(async () => {
    if (deletingId || disabledMods.length === 0) return
    const ok = await confirm({
      title: t('toast.deleteDisabledModsConfirm'),
      description: t('toast.deleteDisabledModsConfirmDesc', { count: disabledMods.length }),
      items: disabledMods.map(m => m.name || m.workshop_id),
      confirmLabel: t('toast.deleteAll'),
    })
    if (!ok) {
      return
    }
    setDeletingId('__batch_disabled__')
    try {
      const ids = disabledMods.map(m => m.workshop_id)
      const r = await modsApi.batchDeleteDiskMods(ids)
      toast({
        title: t('toast.bulkDeleteComplete'),
        description: t('toast.bulkDeleteCompleteDesc', {
          deletedFromDisk: r.deletedFromDisk,
          total: r.total,
          modIdsStripped: r.modIdsStripped,
        }),
      })
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: t('toast.bulkDeleteFailed'),
        description: getUserErrorMessage(error, t('toast.bulkDeleteFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setDeletingId(null)
    }
  }, [confirm, deletingId, disabledMods, t, toast, fetchData, fetchDisabled])

  // Bulk delete all ignored mods from disk.
  const handleDeleteAllIgnoredFromDisk = useCallback(async () => {
    if (deletingId || ignoredMods.length === 0) return
    const ok = await confirm({
      title: t('toast.deleteIgnoredModsConfirm'),
      description: t('toast.deleteIgnoredModsConfirmDesc', { count: ignoredMods.length }),
      items: ignoredMods.map(m => m.name || m.workshop_id),
      confirmLabel: t('toast.deleteAll'),
    })
    if (!ok) {
      return
    }
    setDeletingId('__batch_ignored__')
    try {
      const ids = ignoredMods.map(m => m.workshop_id)
      const r = await modsApi.batchDeleteDiskMods(ids)
      toast({
        title: t('toast.bulkDeleteComplete'),
        description: t('toast.bulkDeleteCompleteDesc', {
          deletedFromDisk: r.deletedFromDisk,
          total: r.total,
          modIdsStripped: r.modIdsStripped,
        }),
      })
      await Promise.allSettled([fetchData(), fetchDisabled()])
    } catch (error) {
      toast({
        title: t('toast.bulkDeleteFailed'),
        description: getUserErrorMessage(error, t('toast.bulkDeleteFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setDeletingId(null)
    }
  }, [confirm, deletingId, ignoredMods, t, toast, fetchData, fetchDisabled])

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
      setCollectionStatus((s) => ({ ...s, loading: false, error: err?.message || t('toast.networkErrorDesc') }))
    }
  }, [t])

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
    if (collectionSyncing) return
    setCollectionSyncing(true)
    try {
      const r = await modsApi.collectionSync()
      toast({
        title: r.success ? t('toast.collectionSynced') : t('toast.partialSync'),
        description: r.message,
        variant: r.success ? 'default' : 'destructive',
      })
      fetchCollectionStatus()
    } catch (err: any) {
      toast({ variant: 'destructive', title: t('toast.syncFailed'), description: err?.message || 'Unknown error' })
    } finally {
      setCollectionSyncing(false)
    }
   }, [collectionSyncing, fetchCollectionStatus, t, toast])

  // Fetch mod presets
  const fetchPresets = useCallback(async () => {
    setPresetsLoading(true)
    try {
      const data = await modsApi.getPresets()
      setPresets(data.presets || [])
    } catch (error) {
      reportClientError(t('logic.failedToFetchPresets'), error)
      setFetchError(t('logic.failedToLoadPresets'))
    } finally {
      setPresetsLoading(false)
    }
  }, [t])

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
          setScanIniSnapshot(JSON.stringify({
            ws: cached._workshopIdsSnapshot || [],
            mods: cached._modIdsSnapshot || []
          }))
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
    if (!presetName.trim()) return
    setSavingPreset(true)
    try {
      await modsApi.createPreset(presetName.trim(), presetDescription.trim())
      toast({
        title: t('toast.presetSaved'),
        description: t('toast.presetSavedDesc', { presetName }),
        variant: 'success' as const,
      })
      setSavePresetOpen(false)
      setPresetName('')
      setPresetDescription('')
      fetchPresets()
    } catch (error) {
      toast({
        title: t('toast.presetSaveFailed'),
        description: getUserErrorMessage(error, t('toast.presetSaveFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setSavingPreset(false)
    }
  }

  const handleApplyPreset = async (id: number, _name: string) => {
    setApplyingPreset(id)
    try {
      const result = await modsApi.applyPreset(id)
      toast({
        title: t('toast.presetApplied'),
        description: result.message,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: t('toast.presetApplyFailed'),
        description: getUserErrorMessage(error, t('toast.presetApplyFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setApplyingPreset(null)
      fetchData() // Always resync state — preset may have partially applied
    }
  }

  const handleDeletePreset = async (id: number, name: string) => {
    try {
      await modsApi.deletePreset(id)
      toast({
        title: t('toast.presetDeleted'),
        description: t('toast.presetDeletedDesc', { name }),
        variant: 'success' as const,
      })
      fetchPresets()
    } catch (error) {
      toast({
        title: t('toast.presetDeleteFailed'),
        description: getUserErrorMessage(error, t('toast.presetDeleteFailedDesc')),
        variant: 'destructive',
      })
    }
  }

  // Filtered mods based on search and filters
  const filteredMods = useMemo(() => {
    let result = [...mods]

    if (deferredSearchQuery) {
      const query = deferredSearchQuery.toLowerCase()
      result = result.filter(m =>
        m.name?.toLowerCase().includes(query) ||
        m.workshop_id.includes(query)
      )
    }

    if (showUpdatesOnly) {
      result = result.filter(m => m.update_available)
    }

    return result.sort((a, b) => {
      if (a.update_available !== b.update_available) {
        return b.update_available - a.update_available
      }
      return (a.name || '').localeCompare(b.name || '')
    })
  }, [mods, deferredSearchQuery, showUpdatesOnly])

  // Group mods by status for scannable display.
  // Mods that are tracked but no longer present in the server INI's
  // WorkshopItems= list are routed to a separate "Deactivated" bucket so
  // they don't pollute the active server view.
  const configuredWorkshopIds = useMemo(() => new Set(iniConfig?.workshopIds || []), [iniConfig?.workshopIds])
  const groupedMods = useMemo(() => {
    const updateAvailable: TrackedMod[] = []
    const neverChecked: TrackedMod[] = []
    const upToDate: TrackedMod[] = []
    const deactivated: TrackedMod[] = []
    const configLoaded = iniConfig !== null
    for (const mod of filteredMods) {
      if (configLoaded && !configuredWorkshopIds.has(mod.workshop_id)) {
        deactivated.push(mod)
        continue
      }
      if (mod.update_available) updateAvailable.push(mod)
      else if (!mod.last_checked) neverChecked.push(mod)
      else upToDate.push(mod)
    }
    return { updateAvailable, neverChecked, upToDate, deactivated }
  }, [filteredMods, iniConfig, configuredWorkshopIds])

  const visibleServerMods = useMemo(
    () => [...groupedMods.updateAvailable, ...groupedMods.neverChecked, ...groupedMods.upToDate],
    [groupedMods]
  )

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
    if (busyRef.current) return
    busyRef.current = true
    setChecking(true)
    try {
      const result = await modsApi.checkUpdates()
      // Backend returns `{ updated, mods, error?, skipped? }`. Older code read
      // `result.updatesFound` which never existed → always reported 0.
      const count =
        (Array.isArray(result?.mods) ? result.mods.length : 0) ||
        (typeof result?.updatesFound === 'number' ? result.updatesFound : 0)
      if (result?.error) {
        toast({
          title: t('toast.updateCheckFailed'),
          description: String(result.error),
          variant: 'destructive',
        })
      } else if (result?.skipped) {
        toast({
          title: t('toast.updateCheckSkipped'),
          description: t('toast.updateCheckSkippedDesc'),
        })
      } else {
        toast({
          title: t('toast.updatesChecked'),
          description:
            count === 0
              ? t('toast.allModsUpToDateDesc')
              : t('toast.updatesAvailableDesc', { count }),
        })
      }
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.updateCheckFailed'),
        description: getUserErrorMessage(error, t('toast.updateCheckFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setChecking(false)
      busyRef.current = false
    }
  }

  const discoverWorkshopMod = useCallback(async (workshopId: string) => {
    // Prevent double-triggering
    if (discoveringMod) return

    // Abort any previous discovery request
    discoverAbortRef.current?.abort()
    const controller = new AbortController()
    discoverAbortRef.current = controller

    // Check if already configured
    if (iniConfig?.workshopIds?.includes(workshopId)) {
      toast({
        title: t('toast.alreadyAdded'),
        description: t('toast.alreadyConfiguredDesc'),
        variant: 'default',
      })
      return
    }

    setDiscoveringMod(true)
    setDiscoveredMod(null)
    setSelectedModIds(new Set())

    try {
      const result = await modsApi.discoverModIds(workshopId, undefined, { signal: controller.signal })

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
          title: t('toast.noModIdsFound'),
          description: result.isDownloaded
            ? t('toast.noModInfoFilesDesc')
            : t('toast.modNotDownloadedDesc'),
          variant: 'default',
        })
      } else if (alreadyConfigured.length > 0 && alreadyConfigured.length === uniqueModIds.length) {
        toast({
          title: t('toast.alreadyConfigured'),
          description: t('toast.alreadyConfiguredDesc'),
          variant: 'default',
        })
      } else if (newResult.hasMultipleModIds) {
        toast({
          title: t('toast.multipleModIdsFound'),
          description: t('toast.multipleModIdsFoundDesc', {
            count: uniqueModIds.length,
            newCount: newModIds.length,
            configuredCount: alreadyConfigured.length,
          }),
        })
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return // Superseded by newer request
      toast({
        title: t('toast.discoveryFailed'),
        description: getUserErrorMessage(error, t('toast.discoveryFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setDiscoveringMod(false)
    }
  }, [discoveringMod, iniConfig?.modIds, iniConfig?.workshopIds, t, toast])

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
    const workshopId = parseWorkshopId(advancedModInput)

    if (!workshopId) {
      toast({
        title: t('toast.invalidWorkshopUrl'),
        description: t('toast.invalidWorkshopUrlDesc'),
        variant: 'destructive',
      })
      return
    }

    await discoverWorkshopMod(workshopId)
  }

  // Add mod with selected mod IDs
  const handleAddModAdvanced = async () => {
    if (!discoveredMod || busyRef.current) return
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
          title: t('toast.modAddedToServerConfig'),
          description: t('toast.modAddedToServerConfigDesc', {
            modIds: result.addedModIds.join(', '),
            mapFolders: result.mapFoldersAdded.length > 0
              ? t('toast.mapFolders', { value: result.mapFoldersAdded.join(', ') })
              : '',
          }),
          variant: 'success' as const,
        })
      } else if (result.workshopAlreadyExisted) {
        toast({
          title: t('toast.alreadyConfigured'),
          description: t('toast.alreadyAddedDesc'),
        })
      } else {
        toast({
          title: t('toast.workshopIdAdded'),
          description: t('toast.addedToIniDesc'),
        })
      }

      // Reset and close
      setAdvancedModInput('')
      setDiscoveredMod(null)
      setSelectedModIds(new Set())
      setAdvancedAddOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.addModFailed'),
        description: getUserErrorMessage(error, t('toast.addModFailedDesc')),
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
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.batchRemove([workshopId])
      toast({
        title: t('toast.modRemoved'),
        description: t('toast.modRemovedDesc'),
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.removeFailed'),
        description: getUserErrorMessage(error, t('toast.removeFailedDesc')),
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
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.addToIni(workshopId)
      toast({
        title: t('toast.modReenabled'),
        description: t('toast.modReenabledDesc'),
        variant: 'success' as const,
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.enableFailed'),
        description: getUserErrorMessage(error, t('toast.enableFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  // Bulk: re-enable every selected deactivated mod. Falls back to sequential
  // addToIni calls because there's no dedicated batch endpoint and the volume
  // is expected to be small (handful of leftovers).
  const handleBulkEnable = async (workshopIds: string[]) => {
    if (workshopIds.length === 0 || busyRef.current) return
    busyRef.current = true
    setLoading(true)
    let ok = 0
    let failed = 0
    try {
      for (const id of workshopIds) {
        try {
          await modsApi.addToIni(id)
          ok++
        } catch {
          failed++
        }
      }
      toast({
        title: failed === 0 ? t('toast.modsReenabled') : t('toast.partialReenable'),
        description: t('toast.modsReenabledDesc', { count: ok, failed }),
        variant: failed === 0 ? ('success' as const) : ('destructive' as const),
      })
      setSelectedMods(new Set())
      fetchData()
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleRefreshNames = async (workshopIds?: string[]) => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.refreshNames(workshopIds)
      const total = result.totalResolved ?? 0
      const left = result.unresolved ?? 0
      toast({
        title: total > 0 ? t('toast.resolvedNames', { count: total }) : t('toast.noNewNamesFound'),
        description: total > 0
          ? left > 0
            ? t('toast.refreshNamesResolvedWithUnknownDesc', { disk: result.diskResolved, steam: result.steamResolved, unknown: left })
            : t('toast.refreshNamesResolvedDesc', { disk: result.diskResolved, steam: result.steamResolved })
          : t('toast.refreshNamesNoneDesc', { count: result.checked }),
        variant: total > 0 ? ('success' as const) : ('default' as const),
      })
      if (total > 0) fetchData()
    } catch (error: any) {
      toast({
        title: t('toast.refreshFailed'),
        description: error?.message || t('toast.refreshNamesFailedDesc'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleBulkRemove = async (workshopIdsOverride?: string[]) => {
    const workshopIds = workshopIdsOverride ?? Array.from(selectedMods)
    if (workshopIds.length === 0 || busyRef.current) return
    busyRef.current = true

    setLoading(true)

    try {
      const result = await modsApi.batchRemove(workshopIds) as { success?: boolean; total?: number; dbRemoved?: number; dbFailed?: number; iniRemoved?: number; error?: string }

      if (result.error) {
        throw new Error(result.error)
      }

      if ((result.dbFailed ?? 0) > 0) {
        toast({
          title: t('toast.partialSuccess'),
          description: t('toast.partialSuccessDesc', {
            removed: result.dbRemoved ?? 0,
            failed: result.dbFailed ?? 0,
          }),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('toast.success'),
          description: t('toast.successDesc', { count: result.total ?? workshopIds.length }),
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
        title: t('toast.removeFailed'),
        description: getUserErrorMessage(error, t('toast.bulkDeleteFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleUnignoreMod = async (workshopId: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.unignoreMod(workshopId)
      toast({ title: t('toast.modUnignored'), description: t('toast.modUnignoredDesc') })
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.failedToUnignoreMod'),
        description: error instanceof Error ? error.message : t('toast.unknownErrorDesc'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleClearAllIgnored = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.clearAllIgnoredMods()
       toast({ title: t('toast.ignoreListCleared'), description: result.message || t('toast.ignoreListClearedDesc') })
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.failedToClearIgnoredMods'),
        description: error instanceof Error ? error.message : t('toast.unknownErrorDesc'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleToggleAutoRestart = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.setAutoRestart(!status?.autoRestartEnabled)
      toast({
        title: t('toast.autorestartStatusautorestartenabledDisabledEnabled', {
          status: status?.autoRestartEnabled ? t('ui.disabled').toLowerCase() : t('ui.enabled').toLowerCase(),
        }),
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.settingUpdateFailed'),
        description: error instanceof Error ? error.message : t('toast.failedToUpdateSettingDesc'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleSyncFromServer = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      const result = await modsApi.syncFromServer()
      const parts: string[] = [`Synced ${result.synced || 0} mods from server config`]
      if (result.skippedNonMod > 0) parts.push(`${result.skippedNonMod} non-mod items filtered`)
      if (result.skippedIgnored > 0) parts.push(`${result.skippedIgnored} ignored`)
      toast({
        title: t('toast.modsSynced'),
        description: parts.join('. ') + '.',
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.syncFailed'),
        description: getUserErrorMessage(error, t('toast.syncFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleImportCollection = async () => {
    if (!collectionUrl) {
      toast({
        title: t('toast.noUrlEntered'),
        description: t('toast.noUrlEnteredDesc'),
        variant: 'destructive',
      })
      return
    }
    // Validate format before sending to API
    const trimmed = collectionUrl.trim()
    if (!/^\d{1,15}$/.test(trimmed) && !trimmed.includes('steamcommunity.com')) {
      toast({
        title: t('toast.invalidFormat'),
        description: t('toast.invalidFormatDesc'),
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

      if (mods.length === 0) {
        toast({
          title: t('toast.noModsFound'),
          description: t('toast.noModsFoundDesc'),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('toast.modsFound', { count: mods.length }),
          description: t('toast.selectWhichModsDesc'),
        })
      }
    } catch (error) {
      toast({
        title: t('toast.collectionImportFailed'),
         description: error instanceof Error ? error.message : t('toast.collectionImportFailedDesc'),
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
    const selectedModsList = collectionMods.filter(m => m.selected)

    if (selectedModsList.length === 0) {
      toast({
        title: t('toast.noModsSelected'),
        description: t('toast.noModsSelectedDesc'),
        variant: 'destructive',
      })
      return
    }

    setLoading(true)
    try {
      const results = await Promise.allSettled(
        selectedModsList.map(async (mod) => {
          // Write each mod directly to the server .ini (workshopId + mod IDs + map folders)
          const selectedModIds = mod.modId ? [mod.modId] : undefined
          await modsApi.addModAdvanced(
            mod.workshopId,
            selectedModIds,
            !selectedModIds, // includeAllModIds when no explicit modId was set
            mod.name,
            mod.isMap ? mod.mapFolder : undefined,
          )
          return mod.workshopId
        })
      )

      const added = results.filter(r => r.status === 'fulfilled').length
      const failed = results.filter(r => r.status === 'rejected').length
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          reportClientWarning(`Failed to add mod ${selectedModsList[index].workshopId}.`, result.reason)
        }
      })

      toast({
        title: t('toast.modsAddedToServerConfig', { count: added }),
        description: failed > 0
          ? t('toast.modsAddFailedCount', { count: failed })
          : t('toast.restartToLoadNewMods'),
        variant: failed > 0 ? 'destructive' : 'success' as const,
      })

      setCollectionDialogOpen(false)
      setCollectionMods([])
      setCollectionUrl('')
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.importFailed'),
        description: error instanceof Error ? error.message : t('toast.couldNotAddModsDesc'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleWriteToIni = async () => {
    if (modsToInstall.length === 0) {
      toast({
        title: t('toast.nothingToWrite'),
        description: t('toast.nothingToWriteDesc'),
        variant: 'destructive',
      })
      return
    }

    setLoading(true)
    try {
      const modsData = modsToInstall.map(m => ({
        workshopId: m.workshopId,
        modId: m.modId || m.workshopId
      }))

      const mapFolders = modsToInstall
        .filter(m => m.isMap && m.mapFolder)
        .map(m => m.mapFolder!)

      const result = await modsApi.writeToIni(modsData, mapFolders)

      toast({
        title: t('toast.configurationSaved'),
        description: t('toast.configurationSavedDesc', { count: result.modsConfigured }),
      })

      setModsToInstall([])
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.writeToIniFailed'),
        description: getUserErrorMessage(error, t('toast.writeToIniFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  // Sync mod IDs from downloaded workshop mods to the Mods= line in server.ini
  const handleSyncModIds = async () => {
    setSyncing(true)
    try {
      const result = await modsApi.syncModIds()

      const synced = result.syncedMods?.filter((m: { status?: string }) => m.status?.startsWith('added')).length || 0
      const missing = result.missingMods?.length || 0

      if (synced > 0 || missing > 0) {
        toast({
          title: t('toast.modIdsSynced'),
          description: t('toast.modIdsSyncedDesc', { synced, missing }),
        })
      } else {
        toast({
          title: t('toast.alreadySynced'),
          description: t('toast.alreadySyncedDesc'),
        })
      }

      // Refresh ini config display
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.modIdSyncFailed'),
        description: getUserErrorMessage(error, t('toast.modIdSyncFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setSyncing(false)
    }
  }

  // Drag & drop handlers for mod load order
  const handleDragStart = (index: number) => {
    setDraggedModIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedModIndex === null || draggedModIndex === index) return
    if (draggedModIndex < 0 || draggedModIndex >= orderedModIds.length) return

    // Reorder the mods
    const newOrder = [...orderedModIds]
    const [draggedItem] = newOrder.splice(draggedModIndex, 1)
    newOrder.splice(index, 0, draggedItem)
    setOrderedModIds(newOrder)
    setDraggedModIndex(index)
  }

  const handleDragEnd = () => {
    setDraggedModIndex(null)
  }

  const moveModUp = (index: number) => {
    if (index === 0) return
    const newOrder = [...orderedModIds]
    ;[newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]]
    setOrderedModIds(newOrder)
  }

  const moveModDown = (index: number) => {
    if (index === orderedModIds.length - 1) return
    const newOrder = [...orderedModIds]
    ;[newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]]
    setOrderedModIds(newOrder)
  }

  // Dependency-aware auto-sort. Computes a proposal only; nothing is written
  // until the user applies it and then saves the order.
  const handleAutoSort = () => {
    const requiresByModId = buildRequiresMap(iniConfig?.workshopModMap)
    const result = computeAutoSortedOrder(orderedModIds, requiresByModId)

    if (result.appliedEdges === 0) {
      toast({
        title: result.missing.length > 0 ? t('toast.nothingToSortBy') : t('toast.noDependencyData'),
        description:
          result.missing.length > 0
            ? t('toast.missingDependencies', { count: result.missing.length })
            : t('toast.noDependencyDataDesc'),
      })
      return
    }

    if (result.moved.length === 0) {
      toast({
        title: t('toast.loadOrderAlreadyCorrect'),
        description:
          result.cycles.length > 0
            ? t('toast.circularDependencies', { count: result.cycles.length })
            : t('toast.loadOrderAlreadyCorrectDesc', { appliedEdges: result.appliedEdges }),
      })
      return
    }

    setAutoSortPreview(result)
  }

  const applyAutoSort = () => {
    if (!autoSortPreview) return
    setOrderedModIds(autoSortPreview.order)
    const movedCount = autoSortPreview.moved.length
    setAutoSortPreview(null)
    toast({
      title: t('toast.autosortApplied'),
      description: t('toast.autosortAppliedDesc', { count: movedCount }),
    })
  }

  const handleSaveModOrder = async () => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      setSavingModOrder(true)
      await modsApi.saveModOrder(orderedModIds)
      toast({
        title: t('toast.modOrderSaved'),
        description: t('toast.modOrderUpdatedDesc'),
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.saveOrderFailed'),
        description: getUserErrorMessage(error, t('toast.saveOrderFailedDesc')),
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
  const promoteModOverOpponent = async (winnerModId: string, winnerName: string, loserModId: string, loserName: string) => {
    if (busyRef.current) return
    const source = (iniConfig?.modIds && iniConfig.modIds.length > 0) ? iniConfig.modIds : orderedModIds
    const next = [...source]
    const wi = next.indexOf(winnerModId)
    if (wi === -1 || next.indexOf(loserModId) === -1) {
      toast({
        title: t('toast.cannotReorder'),
        description: t('toast.cannotReorderDesc'),
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
      await modsApi.saveModOrder(next)
      setOrderedModIds(next)
      setConflicts(prev => prev ? { ...prev, modLoadOrder: next } : prev)
      toast({
        title: t('toast.loadOrderUpdated'),
        description: t('toast.loadOrderUpdatedDesc', { winnerName, loserName }),
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.couldNotUpdateLoadOrder'),
        description: getUserErrorMessage(error, t('toast.saveOrderFailedDesc')),
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

  const removeFromInstallList = (workshopId: string) => {
    setModsToInstall(prev => prev.filter(m => m.workshopId !== workshopId))
  }

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
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.setRestartOptions({
        warningMinutes: restartWarningMinutes,
        delayIfPlayersOnline: delayIfPlayersOnline,
        maxDelayMinutes: maxDelayMinutes
      })
      toast({
        title: t('toast.settingsSaved'),
        description: t('toast.settingsSavedDesc'),
      })
      setRestartSettingsOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.settingsSaveFailed'),
        description: getUserErrorMessage(error, t('toast.settingsSaveFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  const handleCancelPendingRestart = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    try {
      await modsApi.cancelPendingRestart()
      toast({
        title: t('toast.restartCancelled'),
        description: t('toast.restartCancelledDesc'),
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('toast.cancelFailed'),
        description: getUserErrorMessage(error, t('toast.cancelFailedDesc')),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      busyRef.current = false
    }
  }

  // Memoized list of mods with updates available
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
    const revealClass = isSelected || anySelected
      ? 'opacity-100'
      : 'opacity-0 group-hover/modrow:opacity-100 focus-within:opacity-100'
    return (
      <div
        key={mod.id}
        className={`group/modrow perf-list-row flex items-center gap-3 px-3 py-2.5 hover:bg-accent/50 motion-safe:transition-colors ${
          isSelected ? 'bg-accent/30' : ''
        }`}
      >
        <div className={`shrink-0 transition-opacity ${revealClass}`}>
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => toggleModSelect(mod.workshop_id)}
            aria-label={t('view.selectMod', { name: mod.name || mod.workshop_id })}
          />
        </div>

        {/* Leading status tile — gives each row a visual anchor and carries
            the per-mod state colour (update / unchecked / up-to-date). */}
        <a
          href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshop_id}`}
          target="_blank"
          rel="noreferrer"
          className={`shrink-0 relative grid place-items-center w-20 h-20 rounded-md border overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${
            mod.update_available
              ? 'border-warning/40 bg-warning/10 text-warning'
              : !mod.last_checked
                ? 'border-border/50 bg-muted/30 text-muted-foreground'
                : 'border-primary/25 bg-primary/[0.06] text-primary/85'
          }`}
          aria-label={t('view.openOnWorkshop', { name: mod.name || `${t('ui.workshopItemBadge')} ${mod.workshop_id}` })}
          title={t('actions.openWorkshop')}
        >
          <Package className="w-8 h-8" aria-hidden="true" />
          <img
            src={demoMode ? `${import.meta.env.BASE_URL}spiffo.png` : `/api/mods/thumbnail/${mod.workshop_id}`}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover rounded-md"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
          />
        </a>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`truncate text-sm ${mod.update_available ? 'font-semibold text-foreground' : 'font-medium text-foreground/95'}`}>
              {mod.name || t('view.modFallback', { id: mod.workshop_id })}
            </span>
            {/* "Not in Config" first — it's a loadability problem, more critical
                than 'Update available'. Use a destructive-toned outlined chip so
                it reads as a structural warning, not the same priority as Update. */}
            {!inConfig && (
              <Badge variant="outline" className="text-[10px] h-5 shrink-0 border-destructive/40 text-destructive bg-destructive/5">
                {t('ui.notInConfig')}
              </Badge>
            )}
            {mod.update_available ? (
              <Badge variant="warning" className="text-[10px] h-5 shrink-0 update-badge-pulse gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning animate-pulse" aria-hidden="true" />
                {t('ui.update')}
              </Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-0.5 text-[11px] text-muted-foreground">
            {/* Workshop ID as a copyable mini-chip with a WS prefix so the
                raw number doesn't read as "just a number". */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    copyText(mod.workshop_id).then(() => {
                      toast({ title: t('toast.copied'), description: t('toast.copiedDesc', { workshopId: mod.workshop_id }) })
                    }).catch(() => { /* no-op */ })
                  }}
                  className="inline-flex items-center gap-1 rounded border border-border/40 bg-muted/40 px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary transition-colors"
                  aria-label={t('view.copyWorkshopId', { id: mod.workshop_id })}
                >
                  <span className="text-[9px] font-semibold uppercase tracking-wider opacity-70">{t('ws')}</span>
                  <span>{mod.workshop_id}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>{t('clickToCopyWorkshopId')}</TooltipContent>
            </Tooltip>
            {mod.last_checked ? (
              <span>{t('ui.checkedDate', { date: new Date(mod.last_checked).toLocaleDateString() })}</span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded border border-dashed border-muted-foreground/30 bg-muted/20 px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground/80">
                <span className="inline-block h-1 w-1 rounded-full bg-muted-foreground/60" aria-hidden="true" />
                {t('ui.unchecked')}
              </span>
            )}
          </div>
        </div>

        {/* Unified action cluster — sits as one tight group on the right so the
            row reads "title block | actions" with no orphaned middle space. */}
        <div className={`shrink-0 flex items-center gap-0.5 transition-opacity ${revealClass}`}>
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshop_id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex"
              >
                <Button
                  variant="ghost"
                  size="iconDense"
                  className="h-8 w-8 text-muted-foreground hover:text-primary"
                  aria-label={t('labels.openWorkshop')}
                >
                  <ExternalLink className="w-4 h-4" />
                </Button>
              </a>
            </TooltipTrigger>
            <TooltipContent>{t('openWorkshopPage')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="iconDense"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => setConfirmRemoveMod(mod.workshop_id)}
                disabled={loading}
                aria-label={t('view.removeMod', { name: mod.name || mod.workshop_id })}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('removeFromServer')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    )
  }, [demoMode, selectedMods, configuredWorkshopIds, loading, toggleModSelect, t, toast])

  // ── Virtualized tracked mods list ──
  type ModGroup = 'update' | 'neverChecked' | 'upToDate' | 'deactivated'
  type FlatModItem =
    | { type: 'header'; group: ModGroup; count: number }
    | { type: 'hint' }
    | { type: 'mod'; mod: TrackedMod; group: ModGroup }

  const modListRef = useRef<HTMLDivElement>(null)

  const flatModItems = useMemo<FlatModItem[]>(() => {
    const items: FlatModItem[] = []
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
  }, [groupedMods, searchQuery, upToDateExpanded, neverCheckedExpanded])

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
  const siblingConflictsMap = useMemo(() => {
    const result = new Map<string, Map<string, Set<string>>>()
    if (!conflicts?.pairs?.length) return result
    // Build modId → wsId lookup from active groups
    const modToWs = new Map<string, string>()
    for (const g of activeModsData.groups) {
      for (const m of g.mods) modToWs.set(m.id, g.wsId)
    }
    for (const pair of conflicts.pairs) {
      const wsA = modToWs.get(pair.modA.modId)
      const wsB = modToWs.get(pair.modB.modId)
      if (!wsA || wsA !== wsB) continue
      // User dismissed this pair as a false positive — skip.
      if (isPairIgnored(pair.modA.modId, pair.modB.modId)) continue
      // Same-workshop conflict — record both directions
      let groupMap = result.get(wsA)
      if (!groupMap) { groupMap = new Map(); result.set(wsA, groupMap) }
      const setA = groupMap.get(pair.modA.modId) || new Set<string>()
      setA.add(pair.modB.modId)
      groupMap.set(pair.modA.modId, setA)
      const setB = groupMap.get(pair.modB.modId) || new Set<string>()
      setB.add(pair.modA.modId)
      groupMap.set(pair.modB.modId, setB)
    }
    return result
  }, [conflicts?.pairs, activeModsData, isPairIgnored])

  const activeModsFiltered = useMemo(() => {
    const { groups } = activeModsData
    const q = deferredModManagerSearch.toLowerCase().trim()
    const filteredGroups = groups
      .map(g => {
        if (!q) return g
        const matchesWs = g.wsId.includes(q)
        if (matchesWs) return g
        const matched = g.mods.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
        if (matched.length === 0) return null
        return { ...g, mods: matched }
      })
      .filter((g): g is WsGroup => g !== null)
    return { filteredGroups }
  }, [activeModsData, deferredModManagerSearch])

  // ── Severity filter: memoized conflict pair counts ──
  const severityCounts = useMemo(() => {
    if (!conflicts?.pairs?.length) return { all: 0, high: 0, medium: 0, low: 0 }
    const allPairs = graphFilterMod
      ? conflicts.pairs.filter(p => p.modA.modId === graphFilterMod || p.modB.modId === graphFilterMod)
      : conflicts.pairs
    return {
      all: allPairs.length,
      real: allPairs.filter(p => p.highCount > 0 || p.mediumCount > 0).length,
      high: allPairs.filter(p => p.highCount > 0).length,
      medium: allPairs.filter(p => p.mediumCount > 0).length,
      low: allPairs.filter(p => p.lowCount > 0).length,
    }
  }, [conflicts?.pairs, graphFilterMod])

  // ── Dependencies sub-tab: memoized unified row list ──
  const depRows = useMemo(() => {
    const missingDeps = conflicts?.missingDeps || []
    const steamDeps = conflicts?.steamDeps || []
    type DepRow = {
      key: string; requiredBy: string; requiredByWsId: string; depName: string
      depModId: string | null; depWorkshopId: string | null; source: 'local' | 'steam'
    }
    const rows: DepRow[] = []
    for (const sd of steamDeps) {
      rows.push({
        key: `steam-${sd.parentWorkshopId}-${sd.childWorkshopId}`,
        requiredBy: sd.parentName, requiredByWsId: sd.parentWorkshopId,
        depName: sd.childName, depModId: null, depWorkshopId: sd.childWorkshopId, source: 'steam',
      })
    }
    for (const dep of missingDeps) {
      const alreadyCovered = steamDeps.some(sd =>
        sd.parentWorkshopId === dep.workshopId && dep.resolvedWorkshopId && sd.childWorkshopId === dep.resolvedWorkshopId
      )
      if (alreadyCovered) continue
      rows.push({
        key: `local-${dep.workshopId}-${dep.missingDep}`,
        requiredBy: dep.modName, requiredByWsId: dep.workshopId,
        depName: dep.resolvedModName || dep.missingDep,
        depModId: dep.missingDep, depWorkshopId: dep.resolvedWorkshopId || null, source: 'local',
      })
    }
    return rows
  }, [conflicts?.missingDeps, conflicts?.steamDeps])

  // Deduped dependency count — steam deps take priority, local deps skip if already covered
  const dedupedDepCount = useMemo(() => {
    const missingDeps = conflicts?.missingDeps || []
    const steamDeps = conflicts?.steamDeps || []
    let count = steamDeps.length
    for (const dep of missingDeps) {
      const alreadyCovered = steamDeps.some(sd =>
        sd.parentWorkshopId === dep.workshopId && dep.resolvedWorkshopId && sd.childWorkshopId === dep.resolvedWorkshopId
      )
      if (!alreadyCovered) count++
    }
    return count
  }, [conflicts?.missingDeps, conflicts?.steamDeps])

  // Memoize conflict-pairs derived data to avoid recalc on every render
  const loadOrderMap = useMemo(() => {
    const entries: [string, number][] = (conflicts?.modLoadOrder ?? []).map((id, i) => [id, i + 1] as [string, number])
    return new Map(entries)
  }, [conflicts?.modLoadOrder])

  const filteredPairs = useMemo(() => {
    if (!conflicts?.pairs?.length) return []
    let pairs = graphFilterMod
      ? conflicts.pairs.filter(p => p.modA.modId === graphFilterMod || p.modB.modId === graphFilterMod)
      : conflicts.pairs
    if (pairSeverityFilter !== 'all') {
      pairs = pairs.filter(p => {
        if (pairSeverityFilter === 'real') return p.highCount > 0 || p.mediumCount > 0
        if (pairSeverityFilter === 'high') return p.highCount > 0
        if (pairSeverityFilter === 'medium') return p.mediumCount > 0
        if (pairSeverityFilter === 'low') return p.lowCount > 0
        return true
      })
    }
    const q = pairSearchQuery.trim().toLowerCase()
    if (q) {
      pairs = pairs.filter(p =>
        p.modA.modName.toLowerCase().includes(q) ||
        p.modB.modName.toLowerCase().includes(q) ||
        p.modA.modId.toLowerCase().includes(q) ||
        p.modB.modId.toLowerCase().includes(q)
      )
    }
    return pairs
  }, [conflicts?.pairs, graphFilterMod, pairSeverityFilter, pairSearchQuery])

  // Top conflicting mods — ranked by number of pairs and severity
  const topConflictingMods = useMemo(() => {
    if (!conflicts?.pairs?.length) return []
    const modStats = new Map<string, { modId: string; modName: string; pairs: number; high: number; medium: number; low: number; files: number }>()
    for (const pair of conflicts.pairs) {
      for (const mod of [pair.modA, pair.modB]) {
        if (!modStats.has(mod.modId)) {
          modStats.set(mod.modId, { modId: mod.modId, modName: mod.modName, pairs: 0, high: 0, medium: 0, low: 0, files: 0 })
        }
        const s = modStats.get(mod.modId)!
        s.pairs++
        s.high += pair.highCount
        s.medium += pair.mediumCount
        s.low += pair.lowCount
        s.files += pair.files.length
      }
    }
    return Array.from(modStats.values()).sort((a, b) => (b.high - a.high) || (b.medium - a.medium) || (b.pairs - a.pairs)).slice(0, 15)
  }, [conflicts?.pairs])

  // Group pairs by their winning mod. A pair is grouped under whoever takes
  // every overlapping file at runtime (mod A, mod B, or a third mod). Pairs
  // with no clear winner (split / unknown) collapse into one "Mixed" bucket.
  // This dramatically de-duplicates rows when one mod (e.g. TchernoLib) wins
  // against many others.
  const groupedPairs = useMemo(() => {
    if (!filteredPairs.length) return [] as Array<{ key: string; name: string; modId: string | null; pairs: typeof filteredPairs }>
    const groups = new Map<string, { key: string; name: string; modId: string | null; pairs: typeof filteredPairs }>()
    for (const pair of filteredPairs) {
      const aw = pair.aWins ?? 0, bw = pair.bWins ?? 0, tp = pair.thirdPartyWins ?? 0, uk = pair.unknownWins ?? 0
      const aWinsAll = aw > 0 && bw === 0 && tp === 0 && uk === 0
      const bWinsAll = bw > 0 && aw === 0 && tp === 0 && uk === 0
      const tpWinsAll = tp > 0 && aw === 0 && bw === 0
      let key: string, name: string, modId: string | null
      if (aWinsAll) { key = pair.modA.modId; name = pair.modA.modName; modId = pair.modA.modId }
      else if (bWinsAll) { key = pair.modB.modId; name = pair.modB.modName; modId = pair.modB.modId }
      else if (tpWinsAll) {
        const tpMod = pair.files.find(f => f.winner && f.winner.modId !== pair.modA.modId && f.winner.modId !== pair.modB.modId)?.winner
        key = tpMod?.modId ?? '__third_party__'
        name = tpMod?.modName ?? t('logic.otherMod')
        modId = tpMod?.modId ?? null
      } else if (aw === 0 && bw === 0 && tp === 0 && uk === 0) {
        // No overlap winner data — fall back to load order
        const posA = loadOrderMap.get(pair.modA.modId)
        const posB = loadOrderMap.get(pair.modB.modId)
        if (posA != null && posB != null && posA !== posB) {
          if (posA > posB) { key = pair.modA.modId; name = pair.modA.modName; modId = pair.modA.modId }
          else { key = pair.modB.modId; name = pair.modB.modName; modId = pair.modB.modId }
        } else {
          key = '__split__'; name = t('ui.mixedUnresolved'); modId = null
        }
      } else {
        key = '__split__'; name = t('ui.mixedUnresolved'); modId = null
      }
      if (!groups.has(key)) groups.set(key, { key, name, modId, pairs: [] })
      groups.get(key)!.pairs.push(pair)
    }
    return [...groups.values()].sort((a, b) => {
      const aSpecial = a.key.startsWith('__'), bSpecial = b.key.startsWith('__')
      if (aSpecial !== bSpecial) return aSpecial ? 1 : -1
      return b.pairs.length - a.pairs.length
    })
  }, [filteredPairs, loadOrderMap, t])

  // After a scan completes, if the user is on the "Real" view but there are
  // no high/medium conflicts, fall back to "Low" so they see something instead
  // of an empty filter.
  useEffect(() => {
    if (!conflicts) return
    if (pairSeverityFilter === 'real' && severityCounts.real === 0 && severityCounts.low > 0) {
      setPairSeverityFilter('low')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts])

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
    setGraphFilterMod(null)
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
        setConflictsError(t('logic.scanTimedOut'))
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
      } catch (err) { reportClientWarning(t('logic.sseInitParseError'), err) }
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
      } catch (err) { reportClientWarning(t('logic.sseModScannedParseError'), err) }
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
      } catch (err) { reportClientWarning(t('logic.sseConflictFoundParseError'), err) }
    })

    es.addEventListener('phase', (e) => {
      resetIdleTimer()
      try {
        const data = JSON.parse(e.data)
        setScanProgress(data.progress)
        if (data.phase === 'hashing') setScanCurrentMod(t('ui.comparingFileContents'))
        if (data.phase === 'grouping') setScanCurrentMod(t('ui.groupingResults'))
      } catch (err) { reportClientWarning(t('logic.ssePhaseParseError'), err) }
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
        setScanIniSnapshot(JSON.stringify({
          ws: iniConfig?.workshopIds?.slice().sort() || [],
          mods: iniConfig?.modIds?.slice().sort() || []
        }))
        setOpenPairs([])
        setScanProgress(100)
      } catch (err) {
        setConflictsError(t('logic.failedToParseScanResults'))
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
          setConflictsError(data.error || t('logic.scanFailed'))
        } catch {
          setConflictsError(t('logic.scanConnectionLost'))
        }
        setConflictsLoading(false)
        toast({ title: t('toast.scanFailed'), description: t('toast.scanFailedDesc'), variant: 'destructive' })
      } else {
        // Connection lost — try to recover cached results from backend.
        // Only show the destructive toast if recovery fails; otherwise the
        // user gets a less alarming "showing cached results" notice inline.
        setConflictsLoading(false)
        modsApi.getCachedConflicts().then(cached => {
          if (closingIntentionallyRef.current) return
          if (cached) {
            setConflicts(cached)
            setConflictsError(t('logic.scanDisconnected'))
          } else {
            setConflictsError(t('logic.scanConnectionLost'))
            toast({ title: t('toast.scanFailed'), description: t('toast.scanFailedDesc'), variant: 'destructive' })
          }
        }).catch(() => {
          if (closingIntentionallyRef.current) return
          setConflictsError(t('logic.scanConnectionLost'))
          toast({ title: t('toast.scanFailed'), description: t('toast.scanFailedDesc'), variant: 'destructive' })
        })
      }
    })
  }, [t, toast, iniConfig?.workshopIds, iniConfig?.modIds])

  return (
    <TooltipProvider>
      <div className="space-y-6 page-transition">
        {fetchError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{t('modDataCouldNotBeLoaded')}</AlertTitle>
            <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 break-words" dir="auto">{fetchError}</span>
              <Button variant="outline" size="sm" onClick={fetchData} className="self-start">
                <RefreshCw className="mr-2 h-4 w-4" /> {t('view.retry')}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {/* Header */}
        <PageHeader
          title={t('title')}
          description={t('subtitle')}
          eyebrow={t('view.workshop')}
          tone="maintain"
          icon={<Package className="w-5 h-5" />}
          actions={
            <Button onClick={() => setAdvancedAddOpen(true)} className="gap-2" variant="command">
              <Plus className="w-4 h-4" />
              {t('view.addMod')}
            </Button>
          }
        />

        {/* Status Bar — only show when mods are tracked */}
        {(status?.totalModsTracked || 0) > 0 && (
        <div className="flex items-center gap-4 rounded-lg border border-border/50 bg-card/60 px-3 py-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Package className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-sm font-medium">{t('view.onServer', { count: status?.totalModsTracked || 0 })}</span>
          </div>
          <Separator orientation="vertical" className="h-4" />
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 cursor-help">
                <Layers className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-sm font-medium">{t('view.inConfig', { count: iniConfig?.workshopIds?.length || 0 })}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('view.workshopItems', { count: iniConfig?.workshopIds?.length || 0 })}</p>
              <p className="text-muted-foreground">{t('view.modIdsInConfig', { count: iniConfig?.totalMods || 0 })}</p>
            </TooltipContent>
          </Tooltip>
          {modsWithUpdates.length > 0 && (
            <>
              <Separator orientation="vertical" className="h-4" />
              <div className="flex items-center gap-2 text-warning">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span className="text-sm font-medium">{t('view.updates', { count: modsWithUpdates.length })}</span>
              </div>
            </>
          )}

          {/* Workshop ACF Status */}
          {!status?.workshopAcfConfigured && (
            <>
              <Separator orientation="vertical" className="h-4" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-2 text-destructive">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span className="text-xs">{t('workshopPathMissing')}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t('cantFindWorkshopDataFileAcf')}</p>
                  <p className="text-xs text-muted-foreground">{t('setTheServerInstallPathInSettingsToEnableUpdateDetection')}</p>
                </TooltipContent>
              </Tooltip>
            </>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={handleSyncFromServer} disabled={loading}>
                  <Download className="w-3.5 h-3.5 mr-1.5" />
                  {t('actions.syncMods')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('syncTrackedModsFromServerIniConfig')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-0" onClick={handleCheckUpdates} disabled={checking}>
                  <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${checking ? 'animate-spin' : ''}`} />
                  {t('checkUpdates')}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {status?.lastCheck ? (() => {
                  const secs = Math.round((Date.now() - new Date(status.lastCheck).getTime()) / 1000)
                  let when: string
                  if (secs < 60) when = `${secs}s ago`
                  else if (secs < 3600) when = `${Math.floor(secs / 60)}m ago`
                  else if (secs < 86400) when = `${Math.floor(secs / 3600)}h ago`
                  else when = new Date(status.lastCheck).toLocaleDateString()
                  return <span>{t('view.lastChecked', { time: when })}</span>
                })() : <span>{t('neverChecked')}</span>}
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={t('actions.moreActions')}>
                  <MoreVertical className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setCollectionDialogOpen(true)}>
                  <Library className="w-4 h-4 mr-2" />
                  {t('actions.importMods')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setRestartSettingsOpen(true)}>
                  <Settings2 className="w-4 h-4 mr-2" />
                  {t('autorestartSettings')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm">{t('autorestart')}</span>
                    <Switch
                      checked={status?.autoRestartEnabled || false}
                      onCheckedChange={handleToggleAutoRestart}
                      disabled={loading}
                      aria-label={t('labels.toggleAutoRestart')}
                    />
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        )}

        {/* Pending Restart Alert */}
        {status?.pendingRestart && (
          <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 sm:items-center">
              <Clock className="w-5 h-5 animate-pulse text-warning" />
              <div>
                <p className="font-medium text-warning">{t('restartPending')}</p>
                <p className="text-xs text-muted-foreground">
                   {t('ui.waitingForPlayers', { minutes: status.maxDelayMinutes })}
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleCancelPendingRestart} disabled={loading} aria-label={t('labels.cancelRestart')}>
              {t('ui.cancel')}
            </Button>
          </div>
        )}

        {/* Stale-flag warning: backend reports N pending updates from live Workshop ACF
            but the per-mod DB flags don't reflect them yet (e.g. last check was rejected,
            or the ACF was rewritten by Steam after a sync). Surface it so it's not invisible
            inside a collapsed group. */}
        {!status?.pendingRestart
          && (status?.updatesAvailable ?? 0) > 0
          && groupedMods.updateAvailable.length === 0
          && !checking && (
          <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 sm:items-center">
              <AlertTriangle className="w-5 h-5 text-warning" />
              <div>
                <p className="font-medium text-warning">
                   {t('ui.updatesReportedBySteam', { count: status?.updatesAvailable })}
                </p>
                <p className="text-xs text-muted-foreground">
                   {t('ui.workshopFolderNewer')}
                </p>
              </div>
            </div>
            <Button variant="warning" size="sm" onClick={handleCheckUpdates} disabled={loading || checking}>
              <RefreshCw className={`w-4 h-4 mr-2 ${checking ? 'animate-spin' : ''}`} />
               {t('ui.checkNow')}
            </Button>
          </div>
        )}

        <Tabs defaultValue="mods" className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <TabsList className="flex h-auto w-full max-w-full justify-start gap-1 overflow-x-auto rounded-md border border-border/55 bg-muted/30 p-1 sm:inline-flex sm:w-auto">
              <TabsTrigger value="mods" className="shrink-0 gap-2 px-3 py-1.5 text-sm font-medium">
                <Package className="w-4 h-4" />
                 {t('ui.serverMods')}
              </TabsTrigger>
              <TabsTrigger value="config" className="shrink-0 gap-2 px-3 py-1.5 text-sm font-medium">
                <Settings2 className="w-4 h-4" />
                 {t('ui.advanced')}
              </TabsTrigger>
              <TabsTrigger value="conflicts" className="shrink-0 gap-2 px-3 py-1.5 text-sm font-medium" onClick={() => { if (!conflicts && !conflictsLoading) scanConflicts() }}>
                <Shield className="w-4 h-4" />
                 {t('ui.conflicts')}
              </TabsTrigger>
              <TabsTrigger value="collection" className="shrink-0 gap-2 px-3 py-1.5 text-sm font-medium">
                <Library className="w-4 h-4" />
                 {t('ui.collection')}
              </TabsTrigger>
              <TabsTrigger value="deactivated" className="shrink-0 gap-2 px-3 py-1.5 text-sm font-medium">
                <EyeOff className="w-4 h-4" />
                 {t('ui.deactivated')}
                {groupedMods.deactivated.length > 0 && (
                  <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-muted-foreground/20 px-1 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {groupedMods.deactivated.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

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
                <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto sm:max-h-[80vh]">
                  <DialogHeader>
                    <DialogTitle>{t('importSteamWorkshopCollection')}</DialogTitle>
                    <DialogDescription>
                      {t('ui.pasteCollectionDesc')}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="collection-url-input">{t('collectionUrlOrId')}</Label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          id="collection-url-input"
                          value={collectionUrl}
                          onChange={(e) => setCollectionUrl(e.target.value)}
                          placeholder={t('input.workshopUrl')}
                          maxLength={200}
                          autoFocus
                        />
                        <Button onClick={handleImportCollection} disabled={importingCollection} className="w-full sm:w-auto">
                          {importingCollection ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Download className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                    </div>

                    {collectionImported && collectionMods.length === 0 && !importingCollection && (
                      <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                         {t('ui.collectionEmpty')}
                      </div>
                    )}

                    {collectionMods.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <Label>{t('ui.foundModsCount', { count: collectionMods.length })}</Label>
                          <div className="flex gap-2 flex-wrap justify-end">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setShowCollectionAdvanced(!showCollectionAdvanced)}
                            >
                              {showCollectionAdvanced ? t('ui.hideAdvancedFields') : t('ui.editIdsAndMaps')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setCollectionMods(prev => prev.map(m => ({ ...m, selected: true })))}
                            >
                               {t('ui.selectAll')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setCollectionMods(prev => prev.map(m => ({ ...m, selected: false })))}
                            >
                               {t('ui.deselectAll')}
                            </Button>
                          </div>
                        </div>
                        <ScrollArea className="h-[min(48vh,22rem)] border rounded-lg p-2 sm:h-[min(52vh,24rem)]">
                          <div className="space-y-2">
                            {collectionMods.map((mod) => {
                              const alreadyInstalled = iniConfig?.workshopIds?.includes(mod.workshopId)
                              return (
                              <div
                                key={mod.workshopId}
                                className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${mod.selected ? 'border-primary/30 bg-primary/10' : 'bg-card/60 hover:bg-accent/20'}`}
                              >
                                <Checkbox
                                  checked={mod.selected}
                                  onCheckedChange={() => toggleModSelection(mod.workshopId)}
                                aria-label={t('view.selectMod', { name: mod.name })}
                                />
                                <div className="flex-1 space-y-1 min-w-0">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="font-medium text-sm truncate">{mod.name}</span>
                                    {alreadyInstalled && (
                                      <Badge variant="outline" className="text-xs text-muted-foreground">
                                        {t('ui.installed')}
                                      </Badge>
                                    )}
                                    {mod.isMap && (
                                      <Badge variant="secondary" className="text-xs">
                                        <MapIcon className="w-3 h-3 mr-1" />
                                 {t('ui.map')}
                                      </Badge>
                                    )}
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    {t('modId')}: {mod.workshopId}
                                  </p>
                                  {mod.selected && showCollectionAdvanced && (
                                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                      <div>
                                        <Label className="text-xs" htmlFor={`collection-mod-id-${mod.workshopId}`}>{t('modId')}</Label>
                                        <Input
                                          id={`collection-mod-id-${mod.workshopId}`}
                                          value={mod.modId || ''}
                                          onChange={(e) => updateModId(mod.workshopId, e.target.value)}
                                          placeholder={t('input.modName')}
                                          maxLength={200}
                                          className="h-7 text-xs"
                                        />
                                      </div>
                                      {mod.isMap && (
                                        <div>
                                          <Label className="text-xs" htmlFor={`collection-map-folder-${mod.workshopId}`}>{t('mapFolder')}</Label>
                                          <Input
                                            id={`collection-map-folder-${mod.workshopId}`}
                                            value={mod.mapFolder || ''}
                                            onChange={(e) => updateMapFolder(mod.workshopId, e.target.value)}
                                            placeholder={t('input.mapFolder')}
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
                                  className="h-10 w-10 sm:h-10 sm:w-10"
                                  onClick={() => openWorkshopPage(mod.workshopId)}
                                  aria-label={t('labels.openWorkshop')}
                                >
                                  <ExternalLink className="w-3 h-3" />
                                </Button>
                              </div>
                            )})}
                          </div>
                        </ScrollArea>
                      </div>
                    )}
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCollectionDialogOpen(false)}>
                      {t('ui.cancel')}
                    </Button>
                    <Button
                      onClick={handleAddCollectionMods}
                      disabled={loading || selectedCollectionCount === 0}
                    >
                      {loading ? t('ui.adding') : t('ui.addModsToServer', { count: selectedCollectionCount })}
                    </Button>
                  </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Add Single Mod Dialog - Improved with Multi-ID support */}
            <Dialog open={advancedAddOpen} onOpenChange={(open) => {
                setAdvancedAddOpen(open)
                if (!open) {
                  setAdvancedModInput('')
                  setDiscoveredMod(null)
                  setSelectedModIds(new Set())
                  setShowAdvancedIdSelection(false)
                  lastAutoDiscoverIdRef.current = null
                  if (autoDiscoverTimeoutRef.current) {
                    clearTimeout(autoDiscoverTimeoutRef.current)
                    autoDiscoverTimeoutRef.current = null
                  }
                }
              }}>
                <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto sm:max-h-[80vh]">
                  <DialogHeader>
                    <DialogTitle>{t('addWorkshopMod')}</DialogTitle>
                    <DialogDescription>
                      <span>{t('ui.pasteWorkshopUrlOrId')} </span>
                      <button
                        type="button"
                        className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 rounded-sm"
                        onClick={() => { setAdvancedAddOpen(false); setCollectionDialogOpen(true) }}
                      >
                        {t('ui.importEntireCollection')}
                      </button>.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    {/* Input section */}
                    <div className="space-y-2">
                      <Label htmlFor="advanced-mod-input" className="sr-only">{t('workshopUrlOrId')}</Label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          id="advanced-mod-input"
                          value={advancedModInput}
                          onChange={(e) => handleModInputChange(e.target.value)}
                          placeholder={t('input.workshopPlaceholder')}
                          onKeyDown={(e) => e.key === 'Enter' && !discoveringMod && handleDiscoverMod()}
                          className="font-mono text-sm"
                          maxLength={200}
                        />
                        <Button
                          id="discover-mod-btn"
                          onClick={handleDiscoverMod}
                          disabled={discoveringMod || !advancedModInput.trim()}
                          variant="secondary"
                          className="w-full shrink-0 sm:w-auto"
                        >
                          {discoveringMod ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <>
                              <Search className="w-4 h-4 mr-1" />
                              {t('ui.discover')}
                            </>
                          )}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t('ui.exampleUrl')}
                      </p>
                    </div>

                    {/* Loading skeleton */}
                    {discoveringMod && (
                      <div className="space-y-3 p-4 border rounded-lg bg-muted/30 animate-pulse">
                        <div className="flex items-start justify-between">
                          <div className="space-y-2 flex-1">
                            <div className="h-4 bg-muted rounded w-3/4" />
                            <div className="h-3 bg-muted rounded w-1/2" />
                          </div>
                          <div className="h-5 bg-muted rounded w-16" />
                        </div>
                        <div className="space-y-1.5">
                          <div className="h-8 bg-muted rounded" />
                          <div className="h-8 bg-muted rounded" />
                        </div>
                      </div>
                    )}

                    {/* Discovered mod info */}
                    {discoveredMod && !discoveringMod && (
                      <div className="space-y-3 p-3 border rounded-lg bg-muted/30">
                        {/* Mod header */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <h4 className="font-medium text-sm truncate" title={discoveredMod.name}>
                              {discoveredMod.name}
                            </h4>
                            <div className="flex items-center gap-2 mt-0.5">
                              <code className="text-xs text-muted-foreground font-mono">
                                {discoveredMod.workshopId}
                              </code>
                              <button
                                onClick={() => window.open(`https://steamcommunity.com/sharedfiles/filedetails/?id=${discoveredMod.workshopId}`, '_blank', 'noopener,noreferrer')}
                                className="text-xs text-primary hover:underline flex items-center gap-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 rounded-sm"
                              >
                                <ExternalLink className="w-3 h-3" />
                                {t('ui.view')}
                              </button>
                            </div>
                          </div>
                          <div className="flex gap-1 shrink-0">
                            {discoveredMod.isMap && (
                              <Badge variant="secondary" className="text-xs h-5">
                                <MapIcon className="w-3 h-3 mr-1" />
                                {t('ui.map')}
                              </Badge>
                            )}
                            {discoveredMod.isDownloaded ? (
                              <Badge variant="success" className="text-xs h-5">
                                <CheckCircle className="w-3 h-3 mr-1" />
                                 {t('ui.downloaded')}
                              </Badge>
                            ) : (
                              <Badge variant="warning" className="text-xs h-5">
                                <Download className="w-3 h-3 mr-1" />
                                 {t('ui.notDownloaded')}
                              </Badge>
                            )}
                          </div>
                        </div>

                        {/* Already added warning */}
                        {discoveredMod.isAlreadyAdded && (
                          <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 p-2 text-xs text-foreground">
                            <Info className="w-4 h-4 text-primary shrink-0" />
                            <span>{t('workshopIdIsAlreadyInYourServerConfig')}</span>
                          </div>
                        )}

                        {/* Mod IDs selection */}
                        {discoveredMod.modIds.length > 0 ? (
                          <div className="space-y-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <Label className="text-xs font-medium">
                                {discoveredMod.hasMultipleModIds
                                   ? t('ui.modIdsSelected', { selected: selectedModIds.size, total: discoveredMod.modIds.length })
                                  : t('ui.modId')}
                              </Label>
                              {discoveredMod.hasMultipleModIds && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs px-2.5"
                                  onClick={() => setShowAdvancedIdSelection(!showAdvancedIdSelection)}
                                >
                                  {showAdvancedIdSelection ? t('ui.hide') : t('ui.reviewIds')}
                                </Button>
                              )}
                            </div>

                            {discoveredMod.hasMultipleModIds && !showAdvancedIdSelection ? (
                              <p className="text-xs text-muted-foreground">
                                {t('ui.newIdsPreselected')}
                              </p>
                            ) : (
                              <>
                                {discoveredMod.hasMultipleModIds && (
                                  <div className="flex flex-wrap gap-1.5">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs px-2.5"
                                      onClick={() => {
                                        const newIds = discoveredMod.modIds.filter(
                                          id => !discoveredMod.alreadyConfigured?.includes(id)
                                        )
                                        setSelectedModIds(new Set(newIds))
                                      }}
                                    >
                                      {t('ui.selectNew')}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs px-2.5"
                                      onClick={() => {
                                        if (selectedModIds.size === discoveredMod.modIds.length) {
                                          setSelectedModIds(new Set())
                                        } else {
                                          setSelectedModIds(new Set(discoveredMod.modIds))
                                        }
                                      }}
                                    >
                                      {selectedModIds.size === discoveredMod.modIds.length ? t('ui.none') : t('ui.all')}
                                    </Button>
                                  </div>
                                )}
                                <div className="space-y-1 max-h-[50vh] overflow-y-auto rounded-lg border border-border/50 bg-background/50 p-1.5">
                                  {discoveredMod.modIds.map((modId) => {
                                    const isConfigured = discoveredMod.alreadyConfigured?.includes(modId)
                                    return (
                                      <div
                                        key={modId}
                                        role="button"
                                        tabIndex={0}
                                        aria-pressed={selectedModIds.has(modId)}
                                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${
                                          selectedModIds.has(modId)
                                            ? 'bg-primary/10 border-l-2 border-l-primary'
                                            : isConfigured
                                              ? 'bg-muted/30 opacity-70'
                                              : 'hover:bg-muted/40'
                                        }`}
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
                                        aria-label={t('view.selectMod', { name: `ID ${modId}` })}
                                        />
                                        <code className="text-xs font-mono flex-1 truncate" title={modId}>
                                          {modId}
                                        </code>
                                        {isConfigured && (
                                          <Badge variant="outline" className="text-xs h-5 shrink-0 text-muted-foreground">
                                            {t('ui.exists')}
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
                            <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                            <div>
                              <p className="font-medium text-warning">
                                {discoveredMod.isDownloaded
                                  ? t('ui.noModInfoFiles')
                                  : t('ui.modNotDownloaded')}
                              </p>
                              <p className="text-muted-foreground mt-0.5">
                                {discoveredMod.isDownloaded
                                  ? t('ui.unconventionalStructure')
                                  : t('ui.addWorkshopIdAndSync')}
                              </p>
                            </div>
                          </div>
                        )}

                        {/* Map folders info */}
                        {discoveredMod.mapFolders.length > 0 && (
                          <div className="flex items-start gap-2 text-xs">
                            <MapIcon className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                            <div>
                              <span className="font-medium">{t('mapFoldersWillBeAdded')}</span>
                              <div className="text-muted-foreground mt-0.5">
                                {discoveredMod.mapFolders.join(', ')}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <DialogFooter className="flex-col sm:flex-row gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setAdvancedAddOpen(false)}
                      className="w-full sm:order-1 sm:w-auto"
                    >
                      {t('ui.cancel')}
                    </Button>
                    <Button
                      onClick={handleAddModAdvanced}
                      disabled={loading || !discoveredMod || discoveringMod}
                      className="w-full sm:order-2 sm:w-auto"
                    >
                      {loading ? (
                        <>
                          <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                          {t('ui.adding')}
                        </>
                      ) : discoveredMod?.modIds.length ? (
                        selectedModIds.size > 0
                           ? t('ui.addModIdsCount', { count: selectedModIds.size })
                          : t('ui.addWorkshopIdOnly')
                      ) : discoveredMod ? (
                        t('ui.addWorkshopId')
                      ) : (
                        t('ui.discoverFirst')
                      )}
                    </Button>
                  </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Restart Settings Dialog */}
            <Dialog open={restartSettingsOpen} onOpenChange={setRestartSettingsOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{t('autorestartSettings')}</DialogTitle>
                    <DialogDescription>
                      {t('ui.configureRestart')}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="restart-warning-minutes">{t('warningTimeMinutes')}</Label>
                      <Input
                        id="restart-warning-minutes"
                        type="number"
                        min="0"
                        max="30"
                        value={restartWarningMinutes}
                        onChange={(e) => setRestartWarningMinutes(parseInt(e.target.value, 10) || 0)}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('ui.restartWarningTime')}
                      </p>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-border/70 bg-card/65 p-3">
                      <div className="space-y-1">
                        <Label>{t('delayIfPlayersOnline')}</Label>
                        <p className="text-xs text-muted-foreground">
                          {t('ui.waitForPlayers')}
                        </p>
                      </div>
                      <Switch
                        checked={delayIfPlayersOnline}
                        onCheckedChange={setDelayIfPlayersOnline}
                      />
                    </div>

                    {delayIfPlayersOnline && (
                      <div>
                        <Label htmlFor="restart-max-delay">{t('maximumDelayMinutes')}</Label>
                        <Input
                          id="restart-max-delay"
                          type="number"
                          min="5"
                          max="120"
                          value={maxDelayMinutes}
                          onChange={(e) => setMaxDelayMinutes(parseInt(e.target.value, 10) || 30)}
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          {t('ui.forceRestartAfter')}
                        </p>
                      </div>
                    )}

                    <div className="rounded-lg border border-border/70 bg-secondary/40 p-3">
                      <p className="text-sm font-medium mb-2">{t('currentSettings')}</p>
                      <div className="text-xs text-muted-foreground space-y-1">
                         <p>• {t('ui.warningTimeSummary', { minutes: restartWarningMinutes })}</p>
                        <p>• {t('ui.delayForPlayersYesNo', { value: delayIfPlayersOnline ? t('ui.yes') : t('ui.no') })}</p>
                         {delayIfPlayersOnline && <p>• {t('ui.maxDelaySummary', { minutes: maxDelayMinutes })}</p>}
                      </div>
                    </div>
                  </div>
                  <DialogFooter className="flex-col sm:flex-row gap-2">
                    <Button variant="outline" onClick={() => setRestartSettingsOpen(false)} className="w-full sm:w-auto">
                       {t('ui.cancel')}
                    </Button>
                    <Button onClick={handleSaveRestartSettings} disabled={loading} className="w-full sm:w-auto">
                      {loading ? t('ui.saving') : t('ui.saveSettings')}
                    </Button>
                  </DialogFooter>
                </DialogContent>
            </Dialog>
          </div>

          {/* Server Mods Tab — auto-tracks every workshop ID in the server INI. */}
          <TabsContent value="mods" className="space-y-4">
            {/* Search and Filters */}
            {mods.length > 0 && (
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1 sm:max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder={t('filters.search')}
                  maxLength={200}
                  className="pl-9"
                  aria-label={t('filters.search')}
                />
              </div>

              <Button
                variant={showUpdatesOnly ? "secondary" : "outline"}
                size="sm"
                onClick={() => setShowUpdatesOnly(!showUpdatesOnly)}
                aria-pressed={showUpdatesOnly}
                className={showUpdatesOnly ? "w-full border-warning/40 bg-warning/15 text-warning hover:bg-warning/25 sm:w-auto" : "w-full sm:w-auto"}
              >
                {showUpdatesOnly ? <Check className="w-4 h-4 mr-2" /> : <Filter className="w-4 h-4 mr-2" />}
                 {t('ui.updatesOnly')}
              </Button>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={showDisabled ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => {
                      const next = !showDisabled
                      setShowDisabled(next)
                      if (next) fetchDisabled()
                    }}
                    aria-pressed={showDisabled}
                    className="w-full sm:w-auto"
                  >
                    {showDisabled ? <EyeOff className="w-4 h-4 mr-2" /> : <Eye className="w-4 h-4 mr-2" />}
                    {showDisabled ? t('ui.hideDisabled') : t('ui.showDisabled')}
                    {showDisabled && disabledMods.length > 0 && (
                      <span className="ml-2 inline-flex items-center justify-center rounded-full bg-muted/40 px-1.5 text-[10px] font-medium tabular-nums">
                        {disabledMods.length}
                      </span>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('modsDownloadedToDiskButNotEnabledInTheServerIni')}</TooltipContent>
              </Tooltip>

              {/* Workshop collection sync indicator. Shown only when an admin
                  has wired up a collection ID. Clicking the chip refreshes
                  the diff; the inline button performs the actual sync. */}
              {collectionStatus.configured && (
                collectionStatus.error ? (
                  <button
                    type="button"
                    onClick={fetchCollectionStatus}
                    title={t('view.collectionErrorTitle', { error: collectionStatus.error })}
                    className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 transition-colors"
                  >
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {t('view.collectionError')}
                  </button>
                ) : collectionStatus.inSync ? (
                  <button
                    type="button"
                    onClick={fetchCollectionStatus}
                    title={collectionStatus.title ? t('view.collectionInSyncTitle', { title: collectionStatus.title }) : t('view.collectionMirrorsTracked')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-success/40 bg-success/10 px-2.5 py-1 text-xs font-medium text-success hover:bg-success/20 transition-colors"
                  >
                    <Check className="w-3.5 h-3.5" />
                    {t('view.collectionInSync')}
                    {collectionStatus.autoSync && <span className="text-[10px] opacity-70">· {t('view.auto')}</span>}
                  </button>
                ) : collectionStatus.drift > 0 ? (
                  <div className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 pl-2.5 pr-1 py-0.5 text-xs font-medium text-warning">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>{t('view.drift', { count: collectionStatus.drift })}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleCollectionSyncNow}
                      disabled={collectionSyncing}
                      className="h-6 px-2 ml-1 text-xs hover:bg-warning/20"
                      title={t('actions.syncToWorkshop')}
                    >
                      {collectionSyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : t('actions.syncMods')}
                    </Button>
                  </div>
                ) : collectionStatus.loading ? (
                  <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {t('view.checkingCollection')}
                  </span>
                ) : null
              )}

              {selectedMods.size > 0 && (
                <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto bulk-bar-enter">
                  <span className="text-sm text-muted-foreground">
                    {t('view.selected', { count: selectedMods.size })}
                  </span>
                  <Button variant="outline" size="sm" onClick={deselectAll}>
                    {t('view.deselect')}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => setConfirmBulkRemove(true)} disabled={loading}>
                    <Trash2 className="w-4 h-4 mr-2" />
                     {t('ui.remove')}
                  </Button>
                </div>
              )}

              {selectedMods.size === 0 && visibleServerMods.length > 0 && (
                <Button variant="ghost" size="sm" onClick={selectAllVisible} className="ml-auto w-full sm:w-auto">
                  {t('view.selectAll', { count: visibleServerMods.length })}
                </Button>
              )}
            </div>
            )}

            {/* Mods List — grouped by status */}
            <Card>
              <CardContent className="p-0">
                {filteredMods.length === 0 ? (
                  searchQuery ? (
                    <div className="p-6">
                      <EmptyState
                        type="noResults"
                        title={t('empty.noResults')}
                        description={t('empty.tryDifferentSearch')}
                        action={{ label: t('view.clearSearch'), onClick: () => handleSearchChange(''), variant: 'outline' }}
                      />
                    </div>
                  ) : (
                    <div className="px-4 py-10 sm:px-8">
                      <div className="mx-auto max-w-2xl">
                        {/* Hero */}
                        <div className="flex flex-col items-center text-center mb-6">
                          <div className="relative mb-4" aria-hidden="true">
                            <div className="absolute inset-0 rounded-2xl bg-primary/15 blur-xl" />
                            <div className="relative w-16 h-16 rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center">
                              <Package className="w-8 h-8 text-primary" />
                            </div>
                          </div>
                          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/80">
                            {t('view.noModsTracked')}
                          </p>
                          <h3 className="text-base font-semibold text-foreground">{t('addWorkshopModsToStartManagingThem')}</h3>
                          <p className="mt-1.5 text-sm text-muted-foreground max-w-md leading-relaxed">
                            {t('view.noModsTrackedDescription')}
                          </p>
                        </div>

                        {/* 3 paths to populate the list */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-5">
                          <button
                            type="button"
                            onClick={handleSyncFromServer}
                            disabled={loading}
                            className="group text-left rounded-lg border border-border/50 hover:border-primary/40 hover:bg-primary/[0.04] bg-muted/15 px-3 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          >
                            <div className="flex items-center gap-2 mb-1.5">
                              <RefreshCw className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                              <span className="text-xs font-semibold text-foreground/90">{t('syncFromServer')}</span>
                              <ChevronRight className="w-3 h-3 ml-auto text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all" aria-hidden="true" />
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-snug">
                              {t('ui.syncsFromIni')}
                            </p>
                            <p className="mt-1.5 text-[10px] uppercase tracking-wider text-primary/70">{t('recommended')}</p>
                          </button>

                          <button
                            type="button"
                            onClick={() => setCollectionDialogOpen(true)}
                            disabled={loading}
                            className="group text-left rounded-lg border border-border/50 hover:border-primary/40 hover:bg-primary/[0.04] bg-muted/15 px-3 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          >
                            <div className="flex items-center gap-2 mb-1.5">
                              <Library className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                              <span className="text-xs font-semibold text-foreground/90">{t('importACollection')}</span>
                              <ChevronRight className="w-3 h-3 ml-auto text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all" aria-hidden="true" />
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-snug">
                               {t('ui.pasteCollectionDesc')}
                            </p>
                          </button>

                          <button
                            type="button"
                            onClick={() => setAdvancedAddOpen(true)}
                            disabled={loading}
                            className="group text-left rounded-lg border border-border/50 hover:border-primary/40 hover:bg-primary/[0.04] bg-muted/15 px-3 py-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          >
                            <div className="flex items-center gap-2 mb-1.5">
                              <PlusCircle className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                              <span className="text-xs font-semibold text-foreground/90">{t('addASingleMod')}</span>
                              <ChevronRight className="w-3 h-3 ml-auto text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all" aria-hidden="true" />
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-snug">
                               {t('ui.trackSpecificMod')}
                            </p>
                          </button>
                        </div>

                        <p className="text-[11px] text-center text-muted-foreground/70 flex items-center justify-center gap-1.5">
                          <Info className="w-3 h-3" aria-hidden="true" />
                          {t('ui.trackingIsMetadata')}
                        </p>
                      </div>
                    </div>
                  )
                ) : (
                  <div ref={modListRef} className="h-[calc(100vh-340px)] min-h-[300px] overflow-y-auto">
                    <div style={{ height: modListVirtualizer.getTotalSize(), position: 'relative' }}>
                      {modListVirtualizer.getVirtualItems().map(virtualRow => {
                        const item = flatModItems[virtualRow.index]
                        const groupBorder =
                          item.type === 'hint' ? 'border-l-2 border-muted-foreground/30'
                          : item.group === 'update' ? 'border-l-2 border-warning'
                          : item.group === 'neverChecked' ? 'border-l-2 border-muted-foreground/30'
                          : 'border-l-2 border-primary/30'

                        return (
                          <div
                            key={virtualRow.key}
                            className={groupBorder}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              transform: `translateY(${virtualRow.start}px)`,
                            }}
                          >
                            {item.type === 'header' && item.group === 'update' && (
                              <div className="flex items-center gap-2.5 bg-warning/10 px-4 py-2.5 border-b border-warning/25">
                                <span className="relative inline-flex shrink-0" aria-hidden="true">
                                  <span className="absolute inset-0 rounded-full bg-warning/40 animate-ping" />
                                  <span className="relative w-2 h-2 rounded-full bg-warning" />
                                </span>
                                <span className="text-sm font-semibold text-warning">
                                  {t('ui.updatesAvailable')}
                                </span>
                                <span className="inline-flex h-5 items-center rounded-full bg-warning/20 px-2 font-mono text-[11px] tabular-nums text-warning">
                                  {item.count}
                                </span>
                              </div>
                            )}
                            {item.type === 'header' && item.group === 'neverChecked' && (
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 bg-muted/20 px-4 py-2 border-b border-border/40 hover:bg-muted/30 transition-colors text-left"
                                onClick={() => setNeverCheckedExpanded(!neverCheckedExpanded)}
                                aria-expanded={neverCheckedExpanded}
                              >
                                <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${neverCheckedExpanded ? 'rotate-90' : ''}`} />
                                <Clock className="w-4 h-4 text-muted-foreground" />
                                <span className="text-sm font-medium text-muted-foreground">
                                  {t('ui.neverChecked')}
                                </span>
                                <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
                                  {item.count}
                                </span>
                                {!neverCheckedExpanded && (
                                  <span className="ml-auto text-[11px] text-muted-foreground/70">
                                    {t('ui.clickToExpandOrCheck')}
                                  </span>
                                )}
                              </button>
                            )}
                            {item.type === 'header' && item.group === 'upToDate' && (
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 bg-primary/5 px-4 py-2 border-b border-border/40 hover:bg-primary/10 transition-colors text-left"
                                onClick={() => setUpToDateExpanded(!upToDateExpanded)}
                                aria-expanded={upToDateExpanded}
                              >
                                <ChevronRight className={`w-4 h-4 text-primary transition-transform ${upToDateExpanded ? 'rotate-90' : ''}`} />
                                <CheckCircle className="w-4 h-4 text-primary" />
                                <span className="text-sm font-medium text-primary">
                                  {t('ui.upToDate')}
                                </span>
                                <span className="font-mono text-[11px] tabular-nums text-primary/80">
                                  {item.count}
                                </span>
                              </button>
                            )}
                            {item.type === 'hint' && (
                              <div className="flex items-center gap-3 bg-primary/5 border-b border-border/40 px-4 py-3">
                                <RefreshCw className="w-4 h-4 text-primary shrink-0" />
                                <p className="text-sm text-muted-foreground">
                                  {t('ui.clickCheckUpdates')}
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
                )}
              </CardContent>
            </Card>

            {/* ─── Disabled mods ──────────────────────────────────────────
                Mods downloaded into the Workshop content folder but not in
                the server INI's WorkshopItems= list. Hidden by default; the
                "Show disabled" toggle in the filter bar reveals this panel
                and triggers a one-shot fetch. Each row offers a quick Enable
                that adds it to the INI (and lifts any prior ignore-list
                entry so auto-track picks it up). */}
            {showDisabled && (
              <div className="rounded-lg border border-dashed border-border/50 bg-card/40">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30">
                  <div className="flex items-center gap-2 text-sm">
                    <EyeOff className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="font-medium text-muted-foreground">{t('disabledModsOnDisk')}</span>
                    {!disabledLoading && (
                      <span className="text-xs text-muted-foreground/70">
                         — {t('ui.downloadedButNotLoaded')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={fetchDisabled}
                      disabled={disabledLoading}
                    >
                      {disabledLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      <span className="ml-1.5">{t('refresh')}</span>
                    </Button>
                    {disabledMods.length > 0 && !disabledLoading && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={handleDeleteAllDisabled}
                        disabled={deletingId !== null || loading}
                      >
                        {deletingId === '__batch_disabled__' ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                        <span className="ml-1.5">{t('deleteAll')}</span>
                      </Button>
                    )}
                  </div>
                </div>
                {disabledLoading ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                     {t('ui.scanningWorkshop')}
                  </div>
                ) : disabledMods.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                     {t('ui.noDisabledMods')}
                  </div>
                ) : (
                  <div className="divide-y divide-border/30">
                    {disabledMods.map((mod) => (
                      <div key={mod.workshop_id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                        <div className="flex items-center gap-2 min-w-0 opacity-70">
                          <Package className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                          <span className="truncate">{mod.name}</span>
                          <span className="text-xs text-muted-foreground/60 tabular-nums shrink-0">{mod.workshop_id}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <a
                                href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshop_id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex"
                              >
                                <Button variant="ghost" size="iconDense" className="h-7 w-7 text-muted-foreground hover:text-primary">
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </Button>
                              </a>
                            </TooltipTrigger>
                            <TooltipContent>{t('openWorkshopPage')}</TooltipContent>
                          </Tooltip>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2.5 text-xs"
                            onClick={() => handleEnableDiskMod(mod.workshop_id)}
                            disabled={enablingId === mod.workshop_id || deletingId !== null || loading}
                          >
                            {enablingId === mod.workshop_id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <>
                                <Plus className="w-3.5 h-3.5 mr-1" />
                                 {t('ui.enable')}
                              </>
                            )}
                          </Button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="iconDense"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                onClick={() => handleDeleteDiskMod(mod.workshop_id, mod.name)}
                                disabled={deletingId !== null || enablingId === mod.workshop_id || loading}
                              >
                                {deletingId === mod.workshop_id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('deleteFromDisk')}</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Ignored Mods — collapsible section */}
            {ignoredMods.length > 0 && (
              <div className="rounded-lg border border-border/30 bg-card/50">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setIgnoredModsOpen(!ignoredModsOpen)}
                >
                  <span className="flex items-center gap-2">
                    <EyeOff className="w-3.5 h-3.5" />
                    {t('ui.ignoredModsCount', { count: ignoredMods.length })}
                    <span className="text-xs opacity-60">{t('ui.ignoredModsSummary')}</span>
                  </span>
                  <ChevronRight className={`w-4 h-4 transition-transform ${ignoredModsOpen ? 'rotate-90' : ''}`} />
                </button>
                {ignoredModsOpen && (
                  <div className="border-t border-border/30 px-4 py-2 space-y-1">
                    {ignoredMods.map((mod) => (
                      <div key={mod.workshop_id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                        <div className="flex items-center gap-2 min-w-0">
                          <EyeOff className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                          <span className="truncate text-muted-foreground">{mod.name || t('logic.workshopMod', { id: mod.workshop_id })}</span>
                          <span className="text-xs text-muted-foreground/50 tabular-nums shrink-0">{mod.workshop_id}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => handleUnignoreMod(mod.workshop_id)}
                            disabled={loading || deletingId !== null}
                          >
                            {t('ui.retrack')}
                          </Button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="iconDense"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                onClick={() => handleDeleteDiskMod(mod.workshop_id, mod.name || undefined)}
                                disabled={deletingId !== null || loading}
                              >
                                {deletingId === mod.workshop_id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('deleteFromDisk')}</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    ))}
                    <div className="flex justify-end gap-1 pt-1 pb-0.5 border-t border-border/20 mt-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={handleDeleteAllIgnoredFromDisk}
                        disabled={loading || deletingId !== null}
                      >
                        {deletingId === '__batch_ignored__' ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                        <span className="ml-1.5">{t('deleteAllFromDisk')}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={handleClearAllIgnored}
                        disabled={loading || deletingId !== null}
                      >
                         {t('ui.clearAllIgnored')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          {/* Server Config Tab */}
          <TabsContent value="config" className="space-y-4">
            {iniConfig?.configured ? (
              <>
                {/* ─── Sub-tab nav ─── */}
                <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-border/50 bg-card/45 p-1 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)]">
                  {([
                    { key: 'active' as const, label: t('ui.activeMods'), icon: <Package className="w-3.5 h-3.5" /> },
                    { key: 'order' as const, label: t('ui.loadOrder'), icon: <GripVertical className="w-3.5 h-3.5" /> },
                    { key: 'add' as const, label: t('ui.addMods'), icon: <Plus className="w-3.5 h-3.5" /> },
                    { key: 'presets' as const, label: t('ui.presets'), icon: <FolderOpen className="w-3.5 h-3.5" /> },
                    { key: 'tools' as const, label: t('ui.tools'), icon: <Wrench className="w-3.5 h-3.5" /> },
                  ]).map(tab => (
                    <button
                      key={tab.key}
                      onClick={() => setConfigSubTab(tab.key)}
                      className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors duration-150 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                        configSubTab === tab.key
                          ? 'bg-primary/12 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.22)]'
                          : 'text-muted-foreground hover:bg-muted/45 hover:text-foreground'
                      }`}
                    >
                      {tab.icon}
                      {tab.label}
                      {tab.key === 'order' && hasModOrderChanged && <span className="w-1.5 h-1.5 rounded-full bg-warning" />}
                    </button>
                  ))}
                </div>

                {/* ─── Summary bar ───
                    Hidden in the Active Mods sub-tab, where the per-row toolbar
                    already shows the more-useful "enabled / total" count. */}
                {configSubTab !== 'active' && (
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="tabular-nums">{iniConfig.totalMods} <span className="opacity-50">{t('mods')}</span></span>
                    <span className="tabular-nums">{t('ui.workshopItemsCount', { count: iniConfig.workshopIds.length })}</span>
                    <span className="tabular-nums">{t('ui.mapsCount', { count: iniConfig.maps.length })}</span>
                  </div>
                )}

                {/* ═══ ACTIVE MODS SUB-TAB ═══ */}
                {configSubTab === 'active' && (() => {
                  const { orphaned, enabledCount, multiIdCount, groups, missingDepsMap, duplicateModIds } = activeModsData
                  const { filteredGroups } = activeModsFiltered
                  const displayGroups = filterMultiId ? filteredGroups.filter(g => g.mods.length > 1) : filteredGroups
                  const totalModCount = groups.reduce((s, g) => s + g.mods.length, 0)
                  const q = deferredModManagerSearch.toLowerCase().trim()
                  const inspectedGroup = groups.find(g => g.wsId === selectedActiveWsId) || displayGroups[0] || null

                  const toggleMod = async (mod: ModEntry, wsId: string) => {
                    if (busyRef.current) return
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
                    } catch (e) { reportClientError(t('logic.failedToToggleMod'), e); toast({ variant: 'destructive', title: t('toast.failedToToggleMod') }) } finally { busyRef.current = false }
                  }

                  // Mark a sibling-conflict pair as a false positive. Used when the
                  // variant detector mis-flags a shared library + dependant
                  // (e.g. DynamicTradingCommon vs DynamicTradingV2) as two
                  // variants of the same mod.
                  const dismissPair = async (a: string, b: string) => {
                    try {
                      await modsApi.addIgnoredModPair(a, b)
                      setIgnoredPairs(prev => {
                        const [x, y] = a < b ? [a, b] : [b, a]
                        if (prev.some(p => p.mod_a === x && p.mod_b === y)) return prev
                        return [...prev, { mod_a: x, mod_b: y, ignored_at: new Date().toISOString() } as any]
                      })
                      toast({ title: t('toast.conflictDismissed'), description: t('toast.conflictDismissedDesc', { a, b }) })
                    } catch (e) {
                      reportClientError(t('logic.failedToDismissConflict'), e)
                      toast({ variant: 'destructive', title: t('toast.failedToDismissConflict') })
                    }
                  }
                  const restorePair = async (a: string, b: string) => {
                    try {
                      await modsApi.removeIgnoredModPair(a, b)
                      setIgnoredPairs(prev => prev.filter(p => {
                        const [x, y] = a < b ? [a, b] : [b, a]
                        return !(p.mod_a === x && p.mod_b === y)
                      }))
                    } catch (e) {
                      reportClientError(t('logic.failedToRestoreConflict'), e)
                    }
                  }

                  const toggleAllInGroup = async (g: WsGroup) => {
                    if (busyRef.current) return
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
                    } catch (e) { reportClientError(t('logic.failedToToggleGroup'), e); toast({ variant: 'destructive', title: t('toast.failedToToggleGroup') }) } finally { busyRef.current = false }
                  }

                  const removeWorkshop = async (wsId: string, knownModIds?: string[]) => {
                    try {
                      await modsApi.removeFromIni(wsId, undefined, knownModIds)
                      const updated = await modsApi.getCurrentConfig()
                      setIniConfig(updated)
                      if (updated?.modIds) setOrderedModIds(updated.modIds)
                      setLastSavedMod(`removed-${wsId}`)
                      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current)
                      savedTimeoutRef.current = setTimeout(() => setLastSavedMod(null), 2000)
                    } catch (e) { reportClientError(t('logic.failedToRemoveWorkshopItem'), e); toast({ variant: 'destructive', title: t('toast.failedToRemoveWorkshopItem') }) }
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

                  const getGroupMissingDeps = (g: WsGroup) => Array.from(new Set(g.mods.flatMap(m => missingDepsMap.get(m.id) || [])))
                  const getGroupDuplicateIds = (g: WsGroup) => g.mods.filter(m => duplicateModIds.has(m.id)).map(m => m.id)

                  const getInspectorDepKey = (g: WsGroup, dep: string) => `active-${g.wsId}-${dep}`

                  const runInspectorDepSearch = async (g: WsGroup, dep: string, force = false) => {
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
                      setDepSearchData(prev => ({ ...prev, [key]: { loading: false, results: [], error: err?.message || t('ui.searchFailed'), searchUrl: null } }))
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
                    if (busyRef.current) return
                    busyRef.current = true
                    setDepAdding(prev => [...prev, key])
                    try {
                      await modsApi.addMissingDep(hit.workshopId, hit.modId || dep)
                      setDepAddResults(prev => ({ ...prev, [key]: 'added' as const }))
                      const updated = await modsApi.getCurrentConfig()
                      setIniConfig(updated)
                      if (updated?.modIds) setOrderedModIds(updated.modIds)
                      toast({ title: t('toast.dependencyAdded'), description: t('toast.dependencyAddedDesc', { modName: hit.modName }) })
                    } catch (err) {
                      reportClientError(t('logic.failedToAddDependencyFromInspector'), err)
                      setDepAddResults(prev => ({ ...prev, [key]: 'error' as const }))
                      toast({ title: t('toast.addFailed'), description: err instanceof Error ? err.message : 'Could not add dependency.', variant: 'destructive' })
                    } finally {
                      setDepAdding(prev => prev.filter(item => item !== key))
                      busyRef.current = false
                    }
                  }

                  return (
                    <div className="space-y-3 sub-tab-enter">
                      {detectedConflicts.length > 0 && (
                        <div className="space-y-1.5">
                          {detectedConflicts.map((conflict, idx) => (
                            <div
                              key={idx}
                              className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${
                                conflict.severity === 'warning' ? 'bg-warning/10 border-warning/40' : 'bg-primary/10 border-primary/30'
                              }`}
                            >
                              <AlertTriangle className={`w-3.5 h-3.5 shrink-0 ${conflict.severity === 'warning' ? 'text-warning' : 'text-primary'}`} />
                              <span className="flex-1 min-w-0 break-words">
                                <span className={`font-medium ${conflict.severity === 'warning' ? 'text-warning' : 'text-primary'}`}>
                                  {conflict.type === 'duplicate' && t('ui.duplicateMods')}
                                  {conflict.type === 'missing_modid' && t('ui.missingModIds')}
                                  {conflict.type === 'outdated_dependency' && t('ui.outdatedDependency')}
                                </span>
                                <span className="text-muted-foreground">: {conflict.message}</span>
                              </span>
                              {conflict.type === 'duplicate' && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="shrink-0 h-8 text-xs border-warning/40 text-warning hover:bg-warning/20"
                                  disabled={deduplicating}
                                  onClick={async () => {
                                    setDeduplicating(true)
                                    setDeduplicateResult(null)
                                    try {
                                      const result = await modsApi.deduplicateModIds()
                                      setDeduplicateResult(result.message)
                                      if (result.removed.length > 0) {
                                        const updated = await modsApi.getCurrentConfig()
                                        setIniConfig(updated)
                                        if (updated?.modIds) setOrderedModIds(updated.modIds)
                                      }
                                    } catch (err: unknown) {
                                      const errMsg = err instanceof Error ? err.message : 'Failed to deduplicate'
                                      const msg = errMsg.includes('<')
                                        ? t('ui.failedToDeduplicateEndpoint')
                                        : errMsg
                                      setDeduplicateResult(`Error: ${msg}`)
                                    } finally {
                                      setDeduplicating(false)
                                    }
                                  }}
                                >
                                  {deduplicating ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Wrench className="w-3 h-3 mr-1" />}
                                  {t('ui.fix')}
                                </Button>
                              )}
                            </div>
                          ))}
                          {deduplicateResult && (
                            <p className={`text-xs px-3 ${deduplicateResult.startsWith('Removed') ? 'text-success' : 'text-muted-foreground'}`}>{deduplicateResult}</p>
                          )}
                        </div>
                      )}

                      <div className="rounded-lg border border-border/45 bg-card/35 px-3 py-2.5">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                          <div className="min-w-0 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className="inline-flex items-center gap-1.5 rounded border border-primary/35 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
                                title={`${enabledCount} of ${totalModCount} mod IDs are currently enabled. "Mod IDs" are the internal names PZ loads — a single Workshop item can ship several IDs (variants, add-on packs, etc.).`}
                              >
                                <span className="font-mono tabular-nums text-foreground">{enabledCount}</span>
                                <span className="text-muted-foreground">{t('of')}</span>
                                <span className="font-mono tabular-nums text-foreground">{totalModCount}</span>
                                <span>{t('idsEnabled')}</span>
                              </span>
                              <span className="inline-flex items-center gap-1.5 rounded border border-border/45 bg-muted/25 px-2 py-1 text-[11px] text-muted-foreground">
                                <Package className="h-3 w-3" aria-hidden="true" />
                              <span className="font-mono tabular-nums text-foreground/85">{groups.length}</span>
                                 {t('ui.workshopItemLabel')}
                              </span>
                          {multiIdCount > 0 && (
                            <button
                              onClick={() => setFilterMultiId(!filterMultiId)}
                              title={filterMultiId
                                ? t('ui.showingOnlyMultiIdDetailed')
                                 : t('ui.multiIdTooltip')}
                              className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${filterMultiId ? 'bg-primary/20 border-primary/50 text-primary' : 'border-border/40 text-muted-foreground hover:bg-muted/35 hover:text-foreground'}`}
                            >
                              <Filter className="h-3 w-3" aria-hidden="true" />
                               {t('ui.multiIdCount', { count: multiIdCount })}
                            </button>
                          )}
                          {missingDepsMap.size > 0 && (
                            <span className="inline-flex items-center gap-1.5 rounded border border-destructive/45 bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive" title={t('warnings.missingDependenciesTooltip')}>
                              <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                               {t('ui.missingDepsCount', { count: missingDepsMap.size })}
                            </span>
                          )}
                          {duplicateModIds.size > 0 && (
                            <span className="inline-flex items-center gap-1.5 rounded border border-warning/45 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning" title={t('warnings.duplicateModIdTooltip')}>
                              <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                              {t('ui.duplicateIdsCount', { count: duplicateModIds.size })}
                            </span>
                          )}
                          {lastSavedMod && (
                            <span className="text-[11px] text-success flex items-center gap-1 animate-in fade-in duration-300">
                              <Check className="w-3 h-3" /> {t('view.savedToIni')}
                            </span>
                          )}
                            </div>
                            <p className="text-[11px] leading-4 text-muted-foreground/75">
                              {t('ui.toggleInternalIds')}
                            </p>
                        </div>
                        <div className="relative w-full lg:w-72">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                          <Input value={modManagerSearch} onChange={e => handleModManagerSearchChange(e.target.value)} placeholder={t('filters.activeModsFilter')} aria-label={t('labels.filterActive')} className="h-9 text-xs pl-8 bg-background/60" />
                          {modManagerSearch && (
                            <button onClick={() => { handleModManagerSearchChange('') }} aria-label={t('filters.clearSearch')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 rounded">✕</button>
                          )}
                        </div>
                        </div>
                      </div>

                      {/* (Dependency / duplicate badges are now inline above) */}

                      {/* Scrollable mod list */}
                      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_21rem]">
                      <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-muted/50 shadow-md">
                        {displayGroups.length > 0 ? (
                          <ScrollArea className="h-[calc(100vh-340px)] min-h-[300px]">
                            <div className="min-w-0 divide-y divide-border/60 [&>*:nth-child(even)]:bg-card/70">
                              {displayGroups.map(g => {
                                const isSingle = g.mods.length === 1
                                const mod0 = g.mods[0]
                                const isInspected = inspectedGroup?.wsId === g.wsId
                                // Collect dep/conflict info for the whole group
                                const groupMissing = g.mods.flatMap(m => missingDepsMap.get(m.id) || [])
                                const groupDupes = g.mods.filter(m => duplicateModIds.has(m.id))
                                const groupRequires = g.mods.flatMap(m => m.require || []).filter((v, i, a) => a.indexOf(v) === i)

                                if (isSingle) {
                                  return (
                                    <div
                                      key={g.wsId}
                                      onClick={() => setSelectedActiveWsId(g.wsId)}
                                      className={`perf-list-row group flex flex-wrap items-center gap-2 px-3 py-2.5 transition-colors duration-150 hover:bg-muted/10 sm:flex-nowrap sm:gap-3 ${isInspected ? 'bg-primary/[0.055] shadow-[inset_2px_0_0_hsl(var(--primary)/0.55)]' : ''} ${!mod0.enabled ? 'opacity-60' : ''}`}
                                    >
                                      <Checkbox
                                        checked={mod0.enabled}
                                        onCheckedChange={() => toggleMod(mod0, g.wsId)}
                                        className="shrink-0"
                                      aria-label={mod0.enabled
                                        ? t('view.disableMod', { name: mod0.name || mod0.id })
                                        : t('view.enableMod', { name: mod0.name || mod0.id })}
                                      />
                                      <div className="min-w-0 flex-[1_1_calc(100%-2rem)] space-y-1 sm:flex-1">
                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                          <span className="text-sm font-semibold leading-tight text-foreground truncate">{mod0.name || mod0.id}</span>
                                          {mod0.name !== mod0.id && (
                                            <span className="inline-flex items-center rounded border border-success/25 bg-success/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-success">
                                              {mod0.id}
                                            </span>
                                          )}
                                          {groupDupes.length > 0 && (
                                            <span className="text-[10px] px-1.5 py-0 rounded bg-warning/15 text-warning border border-warning/30 shrink-0" title={`Also provided by workshop item${duplicateModIds.get(mod0.id)!.length > 2 ? 's' : ''} ${duplicateModIds.get(mod0.id)!.filter(w => w !== g.wsId).join(', ')}`}>
                              {t('ui.duplicate')}
                                            </span>
                                          )}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                          <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium ${mod0.enabled ? 'border-success/30 bg-success/10 text-success' : 'border-border/45 bg-muted/25 text-muted-foreground'}`}>
                                            <span className={`h-1.5 w-1.5 rounded-full ${mod0.enabled ? 'bg-success' : 'bg-muted-foreground/50'}`} aria-hidden="true" />
                                            {mod0.enabled ? t('ui.enabled') : t('ui.disabled')}
                                          </span>
                                          <span className="inline-flex items-center gap-1 rounded border border-border/35 bg-muted/20 px-1.5 py-0.5 font-mono tabular-nums" title={`Workshop ID: ${g.wsId}`}>
                                            {t('ui.wsPrefix', { id: g.wsId })}
                                          </span>
                                        </div>
                                        {mod0.enabled && groupRequires.length > 0 && groupMissing.length > 0 && (
                                          <div className="flex flex-wrap items-center gap-1 rounded border border-destructive/35 bg-destructive/10 px-2 py-1">
                                            <AlertTriangle className="h-3 w-3 text-destructive" aria-hidden="true" />
                                            <span className="text-[10px] font-medium text-destructive/90">{t('missingRequiredId')}</span>
                                            {groupRequires.filter(dep => groupMissing.includes(dep)).map(dep => (
                                              <span key={dep} className="text-[10px] px-1 rounded font-mono bg-destructive/15 text-destructive border border-destructive/30" title={`${dep} is not enabled — this mod may not work`}>
                                                {dep}
                                              </span>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <a
                                            href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${g.wsId}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="rounded p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                                            aria-label={t('view.openOnWorkshop', { name: mod0.name || mod0.id })}
                                          >
                                            <ExternalLink className="w-4 h-4" />
                                          </a>
                                        </TooltipTrigger>
                                        <TooltipContent>{t('openWorkshopPage')}</TooltipContent>
                                      </Tooltip>
                                      <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                          <Button variant="ghost" size="iconDense" className="h-8 w-8 text-muted-foreground hover:text-foreground" aria-label={t('view.moreActions', { name: mod0.name || mod0.id })}>
                                            <MoreVertical className="h-4 w-4" />
                                          </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                          <DropdownMenuItem onClick={() => copyText(g.wsId).then(() => toast({ title: t('toast.copied'), description: t('toast.copiedDesc', { workshopId: g.wsId }) })).catch(() => {})}>
                                            <FileText className="mr-2 h-4 w-4" />
                                             {t('ui.copyWs')}
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem className="text-destructive focus:text-destructive" title={t('tooltips.disableMod')} onClick={() => setConfirmRemoveWorkshop({ wsId: g.wsId, knownModIds: g.mods.map(m => m.id) })}>
                                            <Trash2 className="mr-2 h-4 w-4" />
                                             {t('ui.removeFromServerIni')}
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem className="text-destructive focus:text-destructive" title={t('tooltips.removeMod')} onClick={() => setConfirmRemoveMod(g.wsId)}>
                                            <Trash2 className="mr-2 h-4 w-4" />
                                             {t('removeFromServer')}
                                          </DropdownMenuItem>
                                        </DropdownMenuContent>
                                      </DropdownMenu>
                                    </div>
                                  )
                                }

                                return (
                                  <div
                                    key={g.wsId}
                                    onClick={() => setSelectedActiveWsId(g.wsId)}
                                    className={`perf-list-row group ${isInspected ? 'bg-primary/[0.055] shadow-[inset_2px_0_0_hsl(var(--primary)/0.55)]' : ''} ${!g.someEnabled ? 'opacity-60' : ''}`}
                                  >
                                    <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:flex-nowrap sm:gap-3">
                                      <button
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          setSelectedActiveWsId(g.wsId)
                                        }}
                                        className="flex min-w-0 flex-[1_1_100%] items-center gap-3 text-left transition-colors duration-150 hover:bg-muted/10 focus-visible:outline-none focus-visible:bg-muted/10 sm:-mx-3 sm:-my-2.5 sm:flex-1 sm:px-3 sm:py-2.5"
                                      >
                                        <div className={`w-2 h-2 rounded-sm shrink-0 ${g.allEnabled ? 'bg-success' : g.someEnabled ? 'bg-success/40' : 'bg-muted-foreground/20'}`} />
                                        <div className="min-w-0 flex-1">
                                          <div className="truncate text-sm font-semibold leading-tight text-foreground">{getGroupLabel(g)}</div>
                                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                            <span className="inline-flex items-center gap-1 rounded border border-border/35 bg-muted/20 px-1.5 py-0.5 font-mono tabular-nums" title={`Workshop ID: ${g.wsId}`}>
                                              {t('ui.wsPrefix', { id: g.wsId })}
                                            </span>
                                          </div>
                                        </div>
                                        {(() => {
                                          const enabledN = g.mods.filter(m => m.enabled).length
                                          const totalN = g.mods.length
                                          return (
                                            <span
                                              className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium tabular-nums ${g.allEnabled ? 'border-success/30 bg-success/10 text-success' : g.someEnabled ? 'border-warning/35 bg-warning/10 text-warning' : 'border-border/45 bg-muted/25 text-muted-foreground'}`}
                                              title={
                                                totalN === 1
                                                  ? t('ui.enabledOfTotal', { enabled: enabledN, total: totalN })
                                                  : t('ui.enabledOfTotal', { enabled: enabledN, total: totalN })
                                              }
                                            >
                                              <span>{enabledN}</span>
                                              <span className="opacity-60">{t('of')}</span>
                                              <span>{totalN}</span>
                                              <span className="hidden sm:inline opacity-75">{t('enabled')}</span>
                                            </span>
                                          )
                                        })()}
                                      </button>
                                      <a
                                        href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${g.wsId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-muted-foreground hover:text-foreground hover:bg-muted/40 rounded p-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 shrink-0"
                                        title={`Open workshop page for ${getGroupLabel(g)} — check description to see which mod ID(s) you should enable`}
                                        aria-label={t('view.openOnWorkshop', { name: getGroupLabel(g) })}
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <ExternalLink className="w-4 h-4" />
                                      </a>
                                      <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                          <Button variant="ghost" size="iconDense" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground" aria-label={t('view.moreActions', { name: getGroupLabel(g) })}>
                                            <MoreVertical className="h-4 w-4" />
                                          </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                          <DropdownMenuItem onClick={() => copyText(g.wsId).then(() => toast({ title: t('toast.copied'), description: t('toast.copiedDesc', { workshopId: g.wsId }) })).catch(() => {})}>
                                            <FileText className="mr-2 h-4 w-4" />
                                             {t('ui.copyWs')}
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem className="text-destructive focus:text-destructive" title={t('tooltips.disableMod')} onClick={() => setConfirmRemoveWorkshop({ wsId: g.wsId, knownModIds: g.mods.map(m => m.id) })}>
                                            <Trash2 className="mr-2 h-4 w-4" />
                                             {t('ui.removeFromServerIni')}
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem className="text-destructive focus:text-destructive" title={t('tooltips.removeMod')} onClick={() => setConfirmRemoveMod(g.wsId)}>
                                            <Trash2 className="mr-2 h-4 w-4" />
                                            {t('removeFromServer')}
                                          </DropdownMenuItem>
                                        </DropdownMenuContent>
                                      </DropdownMenu>
                                    </div>
                                    <div className="pl-3 pr-3 pb-2 space-y-1 sm:pl-8">
                                      <div className="flex flex-wrap gap-1">
                                      {(() => {
                                        const groupSiblings = siblingConflictsMap.get(g.wsId)
                                        const enabledSet = new Set(g.mods.filter(m => m.enabled).map(m => m.id))
                                        // Mods that the conflict scanner explicitly flagged as overlapping
                                        const scanClashing = new Set<string>()
                                        if (groupSiblings) {
                                          for (const [modId, sibs] of groupSiblings) {
                                            if (!enabledSet.has(modId)) continue
                                            for (const s of sibs) {
                                              if (enabledSet.has(s)) { scanClashing.add(modId); scanClashing.add(s) }
                                            }
                                          }
                                        }
                                        return (<>
                                        {g.mods.map(mod => {
                                        const isDupe = duplicateModIds.has(mod.id)
                                        const sibConflicts = groupSiblings?.get(mod.id)
                                        const hasScanOverlap = !!sibConflicts && sibConflicts.size > 0
                                        const isScanClashing = scanClashing.has(mod.id)
                                        const sibList = sibConflicts ? Array.from(sibConflicts) : []
                                        const enabledSibs = sibList.filter(s => enabledSet.has(s))
                                        const fmtSibs = (arr: string[]) => {
                                          if (arr.length <= 4) return arr.join(', ')
                                           return `${arr.slice(0, 4).join(', ')} (${t('ui.moreItems', { count: arr.length - 4 })})`
                                        }
                                        const tooltipBits = [
                                          `${mod.id}${mod.name !== mod.id ? ` — ${mod.name}` : ''}`,
                                           isDupe ? t('ui.alsoInWorkshop', { workshop: duplicateModIds.get(mod.id)!.filter(w => w !== g.wsId).join(', ') }) : null,
                                           isScanClashing
                                             ? t('ui.conflictsWith', { mods: fmtSibs(enabledSibs) })
                                             : hasScanOverlap
                                               ? t('ui.variantOf', { siblings: fmtSibs(sibList) })
                                               : null,
                                           t('ui.clickToDisableEnable'),
                                        ].filter(Boolean).join('\n')
                                        // Color priority: scan-confirmed clash > scan overlap > duplicate > normal
                                        // No red flag from heuristics alone — many multi-ID mods are
                                        // legitimately compatible add-on bundles.
                                        const styleClass = isScanClashing
                                          ? (mod.enabled ? 'bg-destructive/20 text-destructive hover:bg-destructive/30 ring-1 ring-destructive/50' : 'bg-destructive/5 text-destructive/60 hover:bg-destructive/10 ring-1 ring-destructive/20')
                                          : hasScanOverlap
                                            ? (mod.enabled ? 'bg-success/15 text-success hover:bg-success/25 ring-1 ring-warning/30' : 'bg-muted/15 text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted/25 ring-1 ring-warning/20')
                                            : isDupe
                                              ? (mod.enabled ? 'bg-warning/15 text-warning hover:bg-warning/25 ring-1 ring-warning/30' : 'bg-warning/5 text-warning/50 hover:bg-warning/10 ring-1 ring-warning/20')
                                              : (mod.enabled
                                                ? 'bg-success/15 text-success hover:bg-success/25'
                                                : 'bg-muted/15 text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted/25')
                                        return (
                                        <button
                                          key={mod.id}
                                          onClick={() => toggleMod(mod, g.wsId)}
                                          title={tooltipBits}
                                          className={`
                                            inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors duration-150 cursor-pointer truncate max-w-[200px] mod-toggle-pill
                                            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-background
                                            ${styleClass}
                                          `}
                                        >
                                          {isScanClashing && <AlertTriangle className="w-2.5 h-2.5 shrink-0 text-destructive" />}
                                          {!isScanClashing && hasScanOverlap && <AlertTriangle className="w-2.5 h-2.5 shrink-0 text-warning/70" />}
                                          <span className="truncate">{mod.id}</span>
                                        </button>
                                        )
                                      })}
                                        </>)
                                      })()}
                                      </div>
                                      {(() => {
                                        const enabledMods = g.mods.filter(m => m.enabled)
                                        const enabledIds = enabledMods.map(m => m.id)
                                        const enabledSet = new Set(enabledIds)
                                        const hasMultipleEnabled = g.mods.length > 1 && enabledIds.length >= 2
                                        // Pairs the scanner explicitly confirmed
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
                                        // Surface dismissed false-positive pairs that involve this group's
                                        // mod IDs so the user can undo a "Not a conflict" mistake.
                                        const groupModIds = new Set(g.mods.map(m => m.id))
                                        const dismissedHere = ignoredPairs.filter(p =>
                                          groupModIds.has(p.mod_a) && groupModIds.has(p.mod_b)
                                        )
                                        if (scanClashingPairs.length > 0) {
                                          return (
                                            <div
                                              role="alert"
                                              className="flex items-start sm:items-center gap-1.5 text-[11px] flex-wrap"
                                            >
                                              <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5 text-destructive shrink-0 mt-px sm:mt-0" />
                                              <span className="text-destructive/90 font-medium min-w-0 break-words">
                                                {t('ui.twoVariantsShareFiles')}
                                              </span>
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation()
                                                  for (const [a, b] of scanClashingPairs) dismissPair(a, b)
                                                }}
                                                title={scanClashingPairs.length === 1
                                                  ? t('ui.markAsFalsePositive', { a: scanClashingPairs[0][0], b: scanClashingPairs[0][1] })
                                                  : t('ui.markAllFalsePositive', { count: scanClashingPairs.length })}
                                                className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border border-border/50 bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                                              >
                                                {t('ui.notAConflict')}
                                              </button>
                                            </div>
                                          )
                                        }
                                        // Subtle hint when scanner found overlaps but only one is enabled — already fine
                                        if (groupSiblings && groupSiblings.size > 0) {
                                          // Find which IDs in this group have known overlaps with siblings
                                          const overlapIds = new Set<string>()
                                          for (const [id, sibs] of groupSiblings) {
                                            if (sibs.size > 0) overlapIds.add(id)
                                          }
                                          const overlapList = Array.from(overlapIds).join(', ')
                                          return (
                                            <div
                                              className="flex items-start sm:items-center gap-1 text-[11px] text-muted-foreground/70 flex-wrap"
                                              title={`These variants share files: ${overlapList}. Enabling more than one would cause the last-loaded mod to overwrite the others. You currently have only one enabled — nothing to fix.`}
                                            >
                                              <Check aria-hidden="true" className="w-3 h-3 text-success/70 shrink-0 mt-px sm:mt-0" />
                                              <span className="min-w-0 break-words">{t('variantsShareFilesOnlyOneIsEnabledWhichIsTheRightSetup')}</span>
                                            </div>
                                          )
                                        }
                                        // Multiple enabled but no scan evidence: passive hint, no panic.
                                        // Many multi-ID workshop items ship compatible add-on bundles.
                                        if (hasMultipleEnabled) {
                                          return (
                                            <div className="flex items-start sm:items-center gap-1 text-[11px] text-muted-foreground/70 flex-wrap">
                                              <Info aria-hidden="true" className="w-3 h-3 shrink-0 mt-px sm:mt-0" />
                                              <span className="min-w-0 break-words">{t('ui.modIdsEnabledHint', { count: enabledIds.length })}</span>
                                              {dismissedHere.length > 0 && (
                                                <button
                                                  type="button"
                                                  onClick={(e) => { e.stopPropagation(); for (const p of dismissedHere) restorePair(p.mod_a, p.mod_b) }}
                                                  title={`Restore ${dismissedHere.length} dismissed conflict pair${dismissedHere.length !== 1 ? 's' : ''} for this workshop item`}
                                                  className="ml-auto text-[10px] underline-offset-2 hover:underline text-muted-foreground/60 hover:text-foreground"
                                                >
                                                  {t('ui.restoreDismissed', { count: dismissedHere.length })}
                                                </button>
                                              )}
                                            </div>
                                          )
                                        }
                                        if (dismissedHere.length > 0) {
                                          return (
                                            <div className="flex items-center gap-1 text-[10px] text-muted-foreground/50 flex-wrap">
                                              <span className="min-w-0">{t('ui.dismissedConflicts', { count: dismissedHere.length })}</span>
                                              <button
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); for (const p of dismissedHere) restorePair(p.mod_a, p.mod_b) }}
                                                className="underline-offset-2 hover:underline hover:text-foreground"
                                              >
                                                {t('ui.restore')}
                                              </button>
                                            </div>
                                          )
                                        }
                                        return null
                                      })()}
                                      {g.someEnabled && groupRequires.length > 0 && groupMissing.length > 0 && (
                                        <div className="flex flex-wrap items-center gap-1 rounded border border-destructive/35 bg-destructive/10 px-2 py-1">
                                          <AlertTriangle className="h-3 w-3 text-destructive" aria-hidden="true" />
                                          <span className="text-[10px] font-medium text-destructive/90">{t('missingRequiredId')}</span>
                                          {groupRequires.filter(dep => groupMissing.includes(dep)).map(dep => (
                                            <span key={dep} className="text-[10px] px-1 rounded font-mono bg-destructive/15 text-destructive border border-destructive/30" title={`${dep} is not enabled — this mod may not work`}>
                                              {dep}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
                              {/* Orphaned mods */}
                              {!filterMultiId && orphaned.filter(id => !q || id.toLowerCase().includes(q)).map(id => (
                                <div key={`orphan-${id}`} className="group flex items-center gap-3 px-3 py-1.5 opacity-60">
                                  <AlertTriangle className="w-3 h-3 text-warning/60 shrink-0" />
                                  <span className="text-xs font-mono truncate flex-1">{id}</span>
                                  <span className="text-[11px] text-warning/50">{t('notOnDisk')}</span>
                                  <button
                                    onClick={async () => {
                                      if (busyRef.current) return
                                      busyRef.current = true
                                      try {
                                        await modsApi.toggleModId(id, false)
                                        const updated = await modsApi.getCurrentConfig()
                                        setIniConfig(updated)
                                        if (updated?.modIds) setOrderedModIds(updated.modIds)
                                      } catch (e) { reportClientError(t('logic.failedToRemoveOrphanedMod'), e); toast({ variant: 'destructive', title: t('toast.failedToRemoveOrphanedMod') }) } finally { busyRef.current = false }
                                    }}
                                    className="text-destructive/80 hover:text-destructive hover:bg-destructive/15 rounded p-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/50"
                                    title={t('view.removeId', { id })}
                                    aria-label={t('view.removeId', { id })}
                                  >
                                    <X className="w-4 h-4" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        ) : (
                          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                             {q ? t('ui.noModsMatching', { query: modManagerSearch }) : t('ui.noModIdsFound')}
                          </div>
                        )}
                      </div>

                      {inspectedGroup && (
                        <aside className="rounded-lg border border-border/55 bg-card/55 shadow-md xl:sticky xl:top-3 xl:self-start" aria-label={t('labels.workshopDetails')}>
                          <div className="border-b border-border/45 px-3 py-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">{t('selectedItem')}</p>
                                <h3 className="mt-1 truncate text-sm font-semibold text-foreground" title={getGroupLabel(inspectedGroup)}>{getGroupLabel(inspectedGroup)}</h3>
                              </div>
                              <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium tabular-nums ${inspectedGroup.allEnabled ? 'border-success/30 bg-success/10 text-success' : inspectedGroup.someEnabled ? 'border-warning/35 bg-warning/10 text-warning' : 'border-border/45 bg-muted/25 text-muted-foreground'}`}>
                                {inspectedGroup.mods.filter(m => m.enabled).length} {t('of')} {inspectedGroup.mods.length}
                              </span>
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                              <span className="inline-flex items-center rounded border border-border/35 bg-muted/20 px-1.5 py-0.5 font-mono tabular-nums">{t('ui.wsPrefix', { id: inspectedGroup.wsId })}</span>
                              {inspectedGroup.mods.length > 1 && <span className="inline-flex items-center rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-primary">{t('multiid')}</span>}
                            </div>
                          </div>

                          <div className="space-y-3 px-3 py-3">
                            <div className="grid grid-cols-2 gap-2">
                              <a
                                href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${inspectedGroup.wsId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border/55 bg-background/55 px-2 text-xs font-medium text-foreground hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                 {t('ui.workshop')}
                              </a>
                              <button
                                type="button"
                                onClick={() => copyText(inspectedGroup.wsId).then(() => toast({ title: t('toast.copied'), description: t('toast.copiedDesc', { workshopId: inspectedGroup.wsId }) })).catch(() => {})}
                                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border/55 bg-background/55 px-2 text-xs font-medium text-foreground hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                              >
                                <FileText className="h-3.5 w-3.5" />
                                 {t('ui.copyWs')}
                              </button>
                            </div>

                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/75">{t('loadedIds')}</p>
                                <button
                                  type="button"
                                  onClick={() => toggleAllInGroup(inspectedGroup)}
                                  className="rounded border border-border/45 bg-muted/25 px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                                >
                                   {inspectedGroup.allEnabled ? t('ui.disableAll') : t('ui.enableAll')}
                                </button>
                              </div>
                              <div className="space-y-1.5">
                                {inspectedGroup.mods.map(mod => {
                                  const missing = missingDepsMap.get(mod.id) || []
                                  const isDupe = duplicateModIds.has(mod.id)
                                  return (
                                    <button
                                      key={mod.id}
                                      type="button"
                                      onClick={() => toggleMod(mod, inspectedGroup.wsId)}
                                      className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 ${mod.enabled ? 'border-success/25 bg-success/10 text-success' : 'border-border/45 bg-muted/20 text-muted-foreground hover:text-foreground'}`}
                                       title={t('ui.clickToDisableEnableMod', { modId: mod.id })}
                                    >
                                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${mod.enabled ? 'bg-success' : 'bg-muted-foreground/45'}`} aria-hidden="true" />
                                      <span className="min-w-0 flex-1 truncate font-mono">{mod.id}</span>
                                      {missing.length > 0 && <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" aria-label={t('dependencies.missing')} />}
                                      {isDupe && <span className="shrink-0 rounded border border-warning/35 bg-warning/10 px-1 py-0 text-[9px] uppercase tracking-wide text-warning">{t('dup')}</span>}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>

                            {getGroupMissingDeps(inspectedGroup).length > 0 && (
                              <div className="rounded border border-destructive/35 bg-destructive/10 px-2 py-2">
                                <div className="flex items-center gap-1.5 text-[11px] font-medium text-destructive">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                  {t('ui.missingRequiredIds')}
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
                                      <div key={dep} className="rounded border border-destructive/25 bg-background/25 p-1.5">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          <button
                                            type="button"
                                            onClick={() => toggleInspectorDepSearch(inspectedGroup, dep)}
                                            className="inline-flex items-center gap-1 rounded border border-destructive/30 bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] text-destructive transition-colors hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/60"
                                            aria-expanded={searchOpen}
                                            aria-controls={`active-dep-search-${key}`}
                                            title={t('view.searchWorkshopFor', { name: dep })}
                                          >
                                            <Search className="h-3 w-3" aria-hidden="true" />
                                            {dep}
                                          </button>
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="h-6 px-2 text-[10px]"
                                            onClick={() => {
                                              if (!searchOpen) toggleInspectorDepSearch(inspectedGroup, dep)
                                              else runInspectorDepSearch(inspectedGroup, dep, true)
                                            }}
                                            disabled={searchState?.loading}
                                          >
                                            {searchState?.loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Search className="mr-1 h-3 w-3" />}
                                            {t('actions.openWorkshop')}
                                          </Button>
                                          {added && <span className="inline-flex items-center gap-1 text-[10px] font-medium text-success"><Check className="h-3 w-3" /> {t('view.added')}</span>}
                                          {errored && <span className="text-[10px] font-medium text-destructive">{t('addFailed')}</span>}
                                        </div>

                                        {searchOpen && (
                                          <div id={`active-dep-search-${key}`} className="mt-2 space-y-2">
                                            {searchState?.loading ? (
                                              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('view.searchWorkshopFor', { name: dep })}
                                              </div>
                                            ) : searchState?.error ? (
                                              <div className="flex items-center justify-between gap-2 text-[11px]">
                                                <span className="break-words text-destructive">{t('view.searchFailed', { error: searchState.error })}</span>
                                                <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => runInspectorDepSearch(inspectedGroup, dep, true)}>{t('ui.retry')}</Button>
                                              </div>
                                            ) : searchState && searchState.results.length === 0 ? (
                                              <div className="space-y-1 text-[11px] text-muted-foreground">
                                                <p>{t('noMatchesFoundTryTheSteamSearchPageIfTheDependencyHasADifferentWorkshopTitle')}</p>
                                                {searchState.searchUrl && (
                                                  <a href={searchState.searchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:text-primary/80">
                                                    <ExternalLink className="h-3 w-3" /> {t('view.openWorkshopSearch')}
                                                  </a>
                                                )}
                                              </div>
                                            ) : searchState && searchState.results.length > 0 ? (
                                              <div className="space-y-1.5">
                                                <p className="text-[10px] text-muted-foreground">{t('pickTheMatchingWorkshopItemThenAddItToTheServerConfig')}</p>
                                                {searchState.results.slice(0, 4).map((hit, hitIndex) => {
                                                  const isBest = hit.matchType === 'exact-id' || hitIndex === 0
                                                  return (
                                                  <div key={`${dep}-${hit.workshopId}-${hit.modId || ''}`} className={`rounded border px-2 py-1.5 ${isBest ? 'border-success/35 bg-success/[0.055]' : 'border-border/40 bg-card/45'}`}>
                                                    <div className="flex items-start justify-between gap-2">
                                                      <div className="min-w-0">
                                                        <div className="flex min-w-0 items-center gap-1.5">
                                                          <p className="truncate text-[11px] font-medium text-foreground" title={hit.modName}>{hit.modName}</p>
                                                          {isBest && (
                                                            <span className="shrink-0 rounded border border-success/35 bg-success/10 px-1 py-0 text-[9px] font-semibold uppercase tracking-wide text-success">
                                                              {t('recommended')}
                                                            </span>
                                                          )}
                                                        </div>
                                                        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                                                          <span className="font-mono">{t('ui.wsPrefix', { id: hit.workshopId })}</span>
                                                          {hit.modId && <span className="font-mono">{t('ui.idPrefix', { id: hit.modId })}</span>}
                                                          <span>{hit.source === 'local' ? 'local' : 'Steam'}</span>
                                                          {hit.matchType === 'exact-id' && <span className="text-success">{t('exactId')}</span>}
                                                        </p>
                                                      </div>
                                                      <div className="flex shrink-0 items-center gap-1">
                                                        <a
                                                          href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${hit.workshopId}`}
                                                          target="_blank"
                                                          rel="noopener noreferrer"
                                                          className="rounded p-1 text-muted-foreground hover:bg-muted/45 hover:text-foreground"
                                                          aria-label={t('view.openOnWorkshop', { name: hit.modName })}
                                                        >
                                                          <ExternalLink className="h-3.5 w-3.5" />
                                                        </a>
                                                        <Button
                                                          type="button"
                                                          variant="outline"
                                                          size="sm"
                                                          className="h-6 px-2 text-[10px]"
                                                          onClick={() => handleInspectorAddDep(hit, dep, key)}
                                                          disabled={adding || added}
                                                        >
                                                          {adding ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : added ? <Check className="mr-1 h-3 w-3" /> : <Plus className="mr-1 h-3 w-3" />}
                                                          {added ? t('view.added') : t('add')}
                                                        </Button>
                                                      </div>
                                                    </div>
                                                  </div>
                                                )})}
                                                {searchState.searchUrl && (
                                                  <a href={searchState.searchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[10px] text-primary hover:text-primary/80">
                                                    <ExternalLink className="h-3 w-3" /> {t('view.openFullWorkshopSearch')}
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

                            {getGroupDuplicateIds(inspectedGroup).length > 0 && (
                              <div className="rounded border border-warning/35 bg-warning/10 px-2 py-2">
                                <div className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                   {t('ui.duplicateInternalIds')}
                                </div>
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {getGroupDuplicateIds(inspectedGroup).map(id => (
                                    <span key={id} className="rounded border border-warning/30 bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] text-warning">{id}</span>
                                  ))}
                                </div>
                              </div>
                            )}

                            <div className="border-t border-border/35 pt-3">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => setConfirmRemoveWorkshop({ wsId: inspectedGroup.wsId, knownModIds: inspectedGroup.mods.map(m => m.id) })}
                              >
                                <Trash2 className="mr-2 h-3.5 w-3.5" />
                                 {t('ui.removeFromServerIni')}
                              </Button>
                            </div>
                          </div>
                        </aside>
                      )}
                      </div>

                      {/* Mods= raw line — collapsed by default */}
                      <details className="pt-2 border-t border-border/20 group/raw">
                        <summary className="text-[11px] text-muted-foreground/60 hover:text-foreground cursor-pointer select-none list-none flex items-center gap-1 transition-colors">
                          <ChevronRight className="w-3 h-3 transition-transform group-open/raw:rotate-90" aria-hidden="true" />
                          {t('view.showRaw', { name: t('mods') })}
                        </summary>
                        <div className="text-[11px] text-muted-foreground font-mono break-all leading-tight mt-1.5" title={`Mods=${iniConfig.modIds?.join(';') || ''}`}>
                          Mods={iniConfig.modIds?.join(';') || ''}
                        </div>
                      </details>

                      {/* Workshop item remove confirmation */}
                      <AlertDialog open={!!confirmRemoveWorkshop} onOpenChange={(open) => { if (!open) setConfirmRemoveWorkshop(null) }}>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t('removeWorkshopItem')}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t('ui.removeWorkshopItemDesc')}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={handleConfirmedRemoveWorkshop}
                            >
                               {t('ui.remove')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )
                })()}

                {/* ═══ LOAD ORDER SUB-TAB ═══ */}
                {configSubTab === 'order' && (() => {
                  // Build modId → display name lookup from workshopModMap + tracked mods
                  const modIdNameMap = new Map<string, string>()
                  const modIdWsMap = new Map<string, string>()
                  const wsMap = iniConfig?.workshopModMap || {}
                  for (const [wsId, details] of Object.entries(wsMap)) {
                    for (const m of details) {
                      if (m.name && m.name !== m.id) modIdNameMap.set(m.id, m.name)
                      modIdWsMap.set(m.id, wsId)
                    }
                  }
                  // Fallback: use tracked mod names matched via workshop ID
                  for (const mod of mods) {
                    const details = wsMap[mod.workshop_id]
                    if (details) {
                      for (const m of details) {
                        if (!modIdNameMap.has(m.id) && mod.name) modIdNameMap.set(m.id, mod.name)
                      }
                    }
                  }

                  return (
                  <div className="space-y-3 sub-tab-enter">
                    {orderedModIds.length === 0 ? (
                      <div className="flex items-center justify-center py-10 text-muted-foreground">
                        <div className="text-center space-y-2">
                          <Layers className="w-8 h-8 mx-auto opacity-30" />
                          <p className="text-sm font-medium text-foreground/70">{t('noModsInLoadOrder')}</p>
                          <p className="text-xs">{t('enableModsInTheActiveModsTabFirst')}</p>
                        </div>
                      </div>
                    ) : (
                    <>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <p className="text-xs text-muted-foreground">{t('dragToReorderChangesAreNotSavedUntilYouClickSave')}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs"
                        onClick={handleAutoSort}
                        disabled={savingModOrder || !!autoSortPreview}
                      >
                        <Wand2 className="w-3 h-3 mr-1" />
                        {t('ui.autoSortByDependencies')}
                      </Button>
                    </div>

                    {autoSortPreview && (
                      <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div className="space-y-0.5">
                            <p className="text-xs font-medium text-foreground">
                              {t('ui.proposedOrder', { count: autoSortPreview.moved.length })}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {t('ui.autoSortDependencyDesc', { count: autoSortPreview.appliedEdges })}
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setAutoSortPreview(null)}>{t('ui.cancel')}</Button>
                            <Button size="sm" className="h-8 text-xs" onClick={applyAutoSort}>{t('apply')}</Button>
                          </div>
                        </div>

                        <ScrollArea className="max-h-40">
                          <div className="space-y-0.5 pr-2">
                            {autoSortPreview.moved.map((move) => (
                              <div key={move.modId} className="flex items-center gap-2 text-[11px]">
                                <span className="tabular-nums text-muted-foreground w-8 text-right shrink-0">#{move.from}</span>
                                <ArrowRight className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                                <span className="tabular-nums text-primary w-8 text-right shrink-0">#{move.to}</span>
                                <span className="font-mono truncate shrink-0">{move.modId}</span>
                                {modIdNameMap.get(move.modId) && (
                                  <span className="text-muted-foreground/60 truncate">{modIdNameMap.get(move.modId)}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </ScrollArea>

                        {autoSortPreview.cycles.length > 0 && (
                          <div className="space-y-0.5">
                            {autoSortPreview.cycles.map((group) => (
                              <p key={group.join('|')} className="text-[11px] text-warning">
                                {t('ui.circularDependency', { deps: group.join(', ') })}
                              </p>
                            ))}
                          </div>
                        )}
                        {autoSortPreview.missing.length > 0 && (
                          <p className="text-[11px] text-muted-foreground">
                            {t('ui.missingRequiredMods', { count: autoSortPreview.missing.length })}
                          </p>
                        )}
                      </div>
                    )}
                    <div className="rounded-lg border border-border bg-muted/50 shadow-md overflow-hidden">
                      <ScrollArea className="h-[calc(100vh-320px)] min-h-[200px]">
                        <div className="divide-y divide-border/60 [&>*:nth-child(even)]:bg-card/70">
                          {orderedModIds
                            .map((modId, idx) => ({ modId, idx }))
                            .filter(({ modId }) => {
                              const q = deferredModManagerSearch.toLowerCase().trim()
                              if (!q) return true
                              if (modId.toLowerCase().includes(q)) return true
                              const name = modIdNameMap.get(modId)
                              return name ? name.toLowerCase().includes(q) : false
                            })
                            .map(({ modId, idx }) => {
                                const displayName = modIdNameMap.get(modId)
                                return (
                                <div
                                  key={`${modId}-${idx}`}
                                  draggable={!modManagerSearch.trim()}
                                  onDragStart={() => handleDragStart(idx)}
                                  onDragOver={(e) => handleDragOver(e, idx)}
                                  onDragEnd={handleDragEnd}
                                  className={`flex items-center gap-2 px-2.5 py-1 cursor-move transition-colors duration-150 hover:bg-muted/15 ${
                                    draggedModIndex === idx ? 'opacity-30 bg-primary/5' : ''
                                  }`}
                                >
                                  <GripVertical className="w-3 h-3 text-muted-foreground/30 shrink-0" />
                                  <span className="text-[11px] tabular-nums text-muted-foreground w-5 text-right shrink-0">{idx + 1}</span>
                                  <span className="text-[11px] font-mono truncate shrink-0">{modId}</span>
                                  {displayName && <span className="text-[11px] text-muted-foreground/60 truncate flex-1">{displayName}</span>}
                                  {!displayName && <span className="flex-1" />}
                                  <div className="flex shrink-0">
                                    <button onClick={() => moveModUp(idx)} disabled={idx === 0} className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-muted/30 disabled:opacity-30 rounded transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50" aria-label={t('actions.moveUp')}>
                                      <ChevronRight className="w-3.5 h-3.5 -rotate-90" />
                                    </button>
                                    <button onClick={() => moveModDown(idx)} disabled={idx === orderedModIds.length - 1} className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-muted/30 disabled:opacity-30 rounded transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50" aria-label={t('actions.moveDown')}>
                                      <ChevronRight className="w-3.5 h-3.5 rotate-90" />
                                    </button>
                                  </div>
                                </div>
                              )})
                            }
                        </div>
                      </ScrollArea>
                      {hasModOrderChanged && (
                        <div className="px-3 py-2 border-t border-border/40 bg-muted/20 flex items-center justify-between">
                          <span className="text-[11px] text-warning">{t('unsavedOrderChanges')}</span>
                          <div className="flex gap-2">
                            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => { setAutoSortPreview(null); setOrderedModIds(iniConfig.modIds) }}>{t('ui.reset')}</Button>
                            <Button size="sm" className="h-8 text-xs" onClick={handleSaveModOrder} disabled={savingModOrder}>
                              {savingModOrder ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
                               {t('ui.saveOrder')}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                    </>
                    )}
                  </div>
                  )
                })()}

                {/* ═══ ADD MODS SUB-TAB ═══ */}
                {configSubTab === 'add' && (
                  <div className="space-y-4 sub-tab-enter">
                    {/* Sync Mod IDs */}
                    <div className="flex flex-col gap-3 rounded-lg border border-border/70 bg-secondary p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{t('syncModIdsFromDownloads')}</p>
                        <p className="text-xs text-muted-foreground">
                           {t('ui.readsModInfo')}
                        </p>
                      </div>
                      <Button
                        onClick={handleSyncModIds}
                        disabled={syncing}
                        size="sm"
                        variant="outline"
                      >
                        {syncing ? (
                          <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4 mr-2" />
                        )}
                         {t('ui.syncModIds')}
                      </Button>
                    </div>

                    {/* Pending Mods to Install */}
                    {modsToInstall.length > 0 && (
                      <div className="space-y-3 rounded-lg border border-border/70 bg-secondary p-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <Label className="flex items-center gap-2">
                            <Plus className="w-4 h-4" />
                            {t('ui.modsQueuedForIni', { count: modsToInstall.length })}
                          </Label>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setModsToInstall([])}
                          >
                            {t('ui.clearAll')}
                          </Button>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {modsToInstall.map(mod => (
                            <Badge key={mod.workshopId} variant="outline" className="max-w-full text-xs sm:max-w-[200px]">
                              <span className="truncate">{mod.name}</span>
                              {mod.isMap && <MapIcon className="w-3 h-3 ml-1" />}
                              <button
                                type="button"
                                aria-label={t('view.removeFromQueue', { name: mod.name })}
                                onClick={() => removeFromInstallList(mod.workshopId)}
                                className="ml-1 hover:text-destructive"
                              >
                                ×
                              </button>
                            </Badge>
                          ))}
                        </div>
                        <Button onClick={handleWriteToIni} disabled={loading} size="sm">
                          <FileText className="w-4 h-4 mr-2" />
                           {t('ui.writeToServerIni')}
                        </Button>
                      </div>
                    )}

                    {modsToInstall.length === 0 && (
                      <div className="text-center py-8 text-muted-foreground">
                        <Plus className="w-10 h-10 mx-auto mb-3 opacity-30" />
                        <p className="text-sm">{t('noModsPending')}</p>
                        <p className="text-xs">{t('useTheServerModsTabToFindAndAddNewWorkshopItemsOrClickSyncToDetectNewDownloads')}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* ═══ PRESETS SUB-TAB ═══ */}
                {configSubTab === 'presets' && (
                  <div className="space-y-4 sub-tab-enter">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">{t('saveAndRestoreModConfigurations')}</p>
                      <Dialog open={savePresetOpen} onOpenChange={setSavePresetOpen}>
                        <DialogTrigger asChild>
                          <Button size="sm" disabled={!iniConfig?.configured}>
                            <Save className="w-4 h-4 mr-2" />
                             {t('ui.saveCurrent')}
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>{t('saveModPreset')}</DialogTitle>
                            <DialogDescription>
                               {t('ui.saveCurrentDesc')}
                            </DialogDescription>
                          </DialogHeader>
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <Label htmlFor="presetName">{t('presetName')}</Label>
                              <Input
                                id="presetName"
                                value={presetName}
                                onChange={(e) => setPresetName(e.target.value)}
                                placeholder={t('presets.namePlaceholder')}
                                maxLength={100}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="presetDesc">{t('descriptionOptional')}</Label>
                              <Input
                                id="presetDesc"
                                value={presetDescription}
                                onChange={(e) => setPresetDescription(e.target.value)}
                                placeholder={t('presets.descriptionPlaceholder')}
                                maxLength={500}
                              />
                            </div>
                            {iniConfig?.configured && (
                              <div className="rounded-lg border border-border/70 bg-secondary p-3 text-sm text-muted-foreground">
                                 {t('ui.presetCounts', { workshopItems: iniConfig.workshopIds?.length || 0, modIds: iniConfig.modIds?.length || 0 })}
                              </div>
                            )}
                          </div>
                          <DialogFooter className="flex-col sm:flex-row gap-2">
                            <Button variant="outline" onClick={() => setSavePresetOpen(false)} className="w-full sm:w-auto">
                               {t('ui.cancel')}
                            </Button>
                            <Button onClick={handleSavePreset} disabled={savingPreset || !presetName.trim()} className="w-full sm:w-auto">
                              {savingPreset && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                               {t('ui.savePreset')}
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </div>

                    {presetsLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : presets.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <FolderOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
                        <p className="text-sm">{t('noPresetsSavedYet')}</p>
                        <p className="text-xs">{t('saveYourCurrentModConfigurationToCreateAPreset')}</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {presets.map((preset) => (
                          <div
                            key={preset.id}
                            className="flex flex-col gap-3 rounded-lg border border-border/70 bg-muted/50 p-3 transition-colors hover:bg-accent/20 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="font-medium truncate">{preset.name}</div>
                              <div className="text-xs text-muted-foreground truncate">
                                 {t('ui.presetSummary', { count: preset.workshop_ids?.length || 0, description: preset.description || t('ui.noDescription') })}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                 {t('ui.savedDate', { date: new Date(preset.created_at).toLocaleDateString() })}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 self-start sm:self-auto">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setConfirmApplyPreset({ id: preset.id, name: preset.name, modCount: preset.workshop_ids?.length || 0 })}
                                disabled={applyingPreset === preset.id}
                              >
                                {applyingPreset === preset.id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Download className="w-4 h-4" />
                                )}
                                <span className="ml-1.5">{t('load')}</span>
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setConfirmDeletePreset({ id: preset.id, name: preset.name })}
                                className="text-destructive hover:text-destructive"
                                aria-label={t('view.deletePreset', { name: preset.name })}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Preset apply confirmation */}
                    <AlertDialog open={!!confirmApplyPreset} onOpenChange={(open) => { if (!open) setConfirmApplyPreset(null) }}>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t('ui.applyPresetConfirm', { name: confirmApplyPreset?.name })}</AlertDialogTitle>
                          <AlertDialogDescription>
                             {t('ui.applyPresetLongDesc', { count: confirmApplyPreset?.modCount || 0 })}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => {
                              if (confirmApplyPreset) {
                                handleApplyPreset(confirmApplyPreset.id, confirmApplyPreset.name)
                                setConfirmApplyPreset(null)
                              }
                            }}
                          >
                             {t('ui.applyPreset')}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>

                    {/* Preset delete confirmation */}
                    <AlertDialog open={!!confirmDeletePreset} onOpenChange={(open) => { if (!open) setConfirmDeletePreset(null) }}>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t('ui.deletePresetConfirm', { name: confirmDeletePreset?.name })}</AlertDialogTitle>
                          <AlertDialogDescription>
                             {t('ui.deletePresetDesc')}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => {
                              if (confirmDeletePreset) {
                                handleDeletePreset(confirmDeletePreset.id, confirmDeletePreset.name)
                                setConfirmDeletePreset(null)
                              }
                            }}
                          >
                             {t('ui.deletePreset')}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}

                {/*  TOOLS SUB-TAB  */}
                {configSubTab === 'tools' && (
                  <div className="space-y-4 sub-tab-enter">
                    <div className="rounded-lg border border-border/40 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <MapIcon className="w-4 h-4" />
                          {t('ui.mapsCount', { count: iniConfig?.maps?.length || 0 })}
                        </div>
                        <button
                          onClick={async () => {
                            try {
                              setRepairingMaps(true)
                              const result = await modsApi.repairMapEntries()
                              setMapRepairResult(result)
                            } catch (err) {
                              reportClientError(t('logic.mapRepairFailed'), err)
                              setMapRepairResult({ removed: [], remaining: iniConfig?.maps || [], message: t('logic.mapRepairFailedCheckConnection') })
                            } finally {
                              setRepairingMaps(false)
                            }
                          }}
                          disabled={repairingMaps}
                          className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-muted hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors disabled:opacity-50"
                          title={t('actions.validateMaps')}
                        >
                          {repairingMaps ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}
                          {t('ui.repair')}
                        </button>
                      </div>
                      {mapRepairResult && (
                        <div className={`p-2 rounded text-xs ${(mapRepairResult.removed.length > 0 || (mapRepairResult.added?.length ?? 0) > 0) ? 'bg-warning/10 text-warning border border-warning/20' : 'bg-success/10 text-success border border-success/20'}`}>
                          {mapRepairResult.message}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1">
                        {iniConfig.maps.map((map, i) => (
                          <Badge key={i} variant="secondary" className="text-xs max-w-[250px] truncate">
                            {map}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    {/* Workshop IDs Review */}
                    <div className="rounded-lg border border-border/40 p-3 space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Package className="w-4 h-4" />
                        {t('ui.workshopItemsCount', { count: iniConfig.workshopIds?.length || 0 })}
                      </div>
                      <div className="flex flex-wrap gap-1 max-h-[200px] overflow-y-auto">
                        {iniConfig.workshopIds?.map((id, i) => (
                          <Badge key={i} variant="outline" className="text-xs font-mono max-w-[140px] truncate">
                            {id}
                          </Badge>
                        ))}
                      </div>
                      <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded font-mono break-all max-h-[80px] overflow-y-auto">
                        WorkshopItems={iniConfig.workshopIds?.join(';') || ''}
                      </div>
                    </div>

                    {/* Operator Notes */}
                    <div className="rounded-lg border border-border/40 p-3 space-y-3 text-sm text-muted-foreground">
                      <div className="text-xs font-semibold text-foreground flex items-center gap-2">
                        <Info className="w-3.5 h-3.5" />
                        {t('ui.operatorNotes')}
                      </div>
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-warning shrink-0" />
                        <div>
                          <p className="font-medium text-foreground text-xs">{t('loadOrderMatters')}</p>
                          <p className="text-xs">{t('frameworksAndDependenciesMustLoadBeforeContentModsWrongOrderCanCauseSilentFailures')}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <MapIcon className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                        <div>
                          <p className="font-medium text-foreground text-xs">{t('mapModsNeedExtraCare')}</p>
                          <p className="text-xs">{t('afterImportingMapModsVerifyMapFolderNamesSoSpawnsAndCellsLoadCorrectly')}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <RefreshCw className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                        <div>
                          <p className="font-medium text-foreground text-xs">{t('syncAfterDownloadingNewMods')}</p>
                          <p className="text-xs">{t('workshopItemsWithoutMatchingModIdsUsuallyMeansSteamHasntFinishedDownloading')}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-8">
                <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">{iniConfig?.error || t('logic.serverConfigNotFound')}</p>
                <p className="text-sm text-muted-foreground">{t('startTheServerOnceItWillCreateTheIniFileAutomatically')}</p>
              </div>
            )}
          </TabsContent>

          {/* ─── Conflicts Tab ─── */}
          <TabsContent value="conflicts" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Shield className="w-4 h-4" aria-hidden="true" />
                       {t('ui.modConflictScanner')}
                    </CardTitle>
                    <CardDescription className="mt-1">
                       {t('ui.conflictScannerDesc')}
                    </CardDescription>
                  </div>
                  {conflicts && !conflictsLoading && (
                    <div className="flex items-center gap-2 shrink-0">
                      {lastScanTime && (
                        <span className="text-[11px] tabular-nums text-muted-foreground/70 hidden sm:inline">
                           {t('ui.lastScan', { time: new Date(lastScanTime).toLocaleTimeString() })}
                        </span>
                      )}
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={scanConflicts} disabled={conflictsLoading}>
                        <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                         {t('ui.rescan')}
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {/* Loading state — streaming scan */}
                {conflictsLoading && !conflicts ? (
                  <div className="py-6">
                    <div className="max-w-md mx-auto space-y-4">
                      {/* Real progress bar */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs text-muted-foreground" aria-live="polite">
                           <span>{scanCurrentMod || t('ui.preparingScan')}</span>
                          {scanProgress > 0 && <span className="tabular-nums">{scanProgress}%</span>}
                        </div>
                        <div className={`h-1.5 rounded-full bg-border/50 overflow-hidden ${scanProgress === 0 ? 'scan-indeterminate' : ''}`} role="progressbar" aria-valuenow={scanProgress} aria-valuemin={0} aria-valuemax={100} aria-label={t('labels.conflictProgress')}>
                          {scanProgress > 0 && (
                            <div
                              className={`h-full rounded-full bg-primary transition-all duration-500 ease-out ${scanProgress > 0 && scanProgress < 100 ? 'scan-progress-glow' : ''} ${scanProgress >= 100 ? 'scan-complete-flash' : ''}`}
                              style={{ width: `${scanProgress}%` }}
                            />
                          )}
                        </div>
                        {scanTotalMods > 0 && (
                          <p className="text-[11px] text-muted-foreground">
                             {t('ui.scannedCount', { scanned: scanModsScanned, total: scanTotalMods })}
                          </p>
                        )}
                      </div>

                      {/* Live conflict feed */}
                      {streamConflicts.length > 0 && (
                        <div className="rounded-lg border border-border/30 bg-muted/10 overflow-hidden" aria-live="polite">
                          <div className="px-3 py-1.5 text-[11px] font-medium text-warning/80 border-b border-border/30 bg-warning/5">
                             {t('ui.conflictsFoundSoFar', { count: streamConflicts[streamConflicts.length - 1]?.conflictsSoFar ?? streamConflicts.length })}
                          </div>
                          <div className="max-h-32 overflow-y-auto">
                            {streamConflicts.slice(-8).map((c) => (
                              <div key={`${c.file}:${c.conflictsSoFar}`} className={`flex items-center gap-2 px-3 py-1 text-[11px] conflict-stream-enter ${
                                c.severity === 'high' ? 'bg-destructive/5' : c.severity === 'medium' ? 'bg-warning/5' : ''
                              }`}>
                                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                  c.severity === 'high' ? 'bg-destructive severity-pulse' : c.severity === 'medium' ? 'bg-warning' : 'bg-primary/50'
                                }`} aria-hidden="true" />
                                <span className="sr-only">{t('ui.severityLabel', { severity: c.severity })}:</span>
                                <span className="font-mono text-foreground/70 truncate flex-1">{c.file}</span>
                                 <span className="text-muted-foreground/70 shrink-0">{t('ui.inModsCount', { count: c.mods.length })}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : conflictsError && !conflicts ? (
                  /* Error state — scan failed with no prior results */
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <div className="text-center max-w-xs space-y-3">
                      <ShieldAlert className="w-10 h-10 mx-auto text-destructive/60" aria-hidden="true" />
                      <div>
                        <p className="font-medium text-foreground text-sm">{t('scanFailed')}</p>
                        <p className="text-xs mt-1.5 text-muted-foreground break-words" dir="auto">{conflictsError}</p>
                        <p className="text-[11px] mt-2 text-muted-foreground leading-relaxed">
                           {t('ui.scanBackendDesc')}
                        </p>
                      </div>
                      <Button variant="outline" size="sm" onClick={scanConflicts} disabled={conflictsLoading}>
                              <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> {t('view.retry')}
                      </Button>
                    </div>
                  </div>
                ) : !conflicts ? (
                  <div className="py-6">
                    <div className="mx-auto max-w-2xl">
                      {/* Hero */}
                      <div className="flex flex-col items-center text-center mb-6">
                        <div className="relative mb-4" aria-hidden="true">
                          <div className="absolute inset-0 rounded-2xl bg-primary/15 blur-xl" />
                          <div className="relative w-16 h-16 rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center">
                            <Shield className="w-8 h-8 text-primary" />
                          </div>
                        </div>
                        <h3 className="text-base font-semibold text-foreground">{t('readyToScanYourMods')}</h3>
                        <p className="mt-1.5 text-sm text-muted-foreground max-w-md leading-relaxed">
                          {t('ui.crossChecksDesc')}
                        </p>
                      </div>

                      {/* What gets checked — 3 columns */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-5">
                        <div className="rounded-lg border border-border/50 bg-muted/15 px-3 py-3">
                          <div className="flex items-center gap-2 mb-1.5">
                            <FileWarning className="w-3.5 h-3.5 text-warning" aria-hidden="true" />
                            <span className="text-xs font-semibold text-foreground/90">{t('fileOverlaps')}</span>
                          </div>
                          <p className="text-[11px] text-muted-foreground leading-snug">
                            {t('ui.luaItemsTextures')}
                          </p>
                        </div>
                        <div className="rounded-lg border border-border/50 bg-muted/15 px-3 py-3">
                          <div className="flex items-center gap-2 mb-1.5">
                            <Layers className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                            <span className="text-xs font-semibold text-foreground/90">{t('loadorderWinners')}</span>
                          </div>
                          <p className="text-[11px] text-muted-foreground leading-snug">
                            {t('ui.identifiesWinner')}
                          </p>
                        </div>
                        <div className="rounded-lg border border-border/50 bg-muted/15 px-3 py-3">
                          <div className="flex items-center gap-2 mb-1.5">
                            <GitBranch className="w-3.5 h-3.5 text-destructive" aria-hidden="true" />
                            <span className="text-xs font-semibold text-foreground/90">{t('missingDependencies')}</span>
                          </div>
                          <p className="text-[11px] text-muted-foreground leading-snug">
                            {t('ui.flagsMissingDeps')}
                          </p>
                        </div>
                      </div>

                      {/* CTA + meta */}
                      <div className="flex flex-col items-center gap-2">
                        <Button onClick={scanConflicts} disabled={conflictsLoading} className="min-w-[200px]">
                          <Shield className="w-4 h-4 mr-2" aria-hidden="true" />
                          {t('ui.scanModsForConflicts')}
                        </Button>
                        <p className="text-[11px] text-muted-foreground/70 flex items-center gap-1.5">
                          <Info className="w-3 h-3" aria-hidden="true" />
                          {t('ui.readOnlyScan')}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className={`space-y-3 stagger-in relative ${conflictsLoading ? 'pointer-events-none' : ''}`}>
                    {/* Re-scan overlay */}
                    {conflictsLoading && (
                      <div className="absolute inset-0 bg-background/60 backdrop-blur-[1px] z-10 flex items-center justify-center rounded-lg transition-opacity duration-200 animate-in fade-in" role="status" aria-busy="true">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
                          {t('ui.scanningMods')}
                        </div>
                      </div>
                    )}

                    {/* Error or fallback banner on re-scan. Tone depends on whether
                        we still have results to show: with results = soft warning
                        ("showing cached"), without = destructive ("scan failed"). */}
                    {conflictsError && (() => {
                      const recovered = !!conflicts
                      const isCacheFallback = /cached results/i.test(conflictsError)
                      const tone = recovered || isCacheFallback
                        ? 'border-warning/30 bg-warning/5 text-warning'
                        : 'border-destructive/30 bg-destructive/5 text-destructive'
                      return (
                        <div className={`rounded-lg border p-3 flex items-center gap-2 text-xs ${tone}`} role={isCacheFallback ? 'status' : 'alert'}>
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                          <span className="flex-1 min-w-0 break-words" dir="auto">{conflictsError}</span>
                          <Button variant="ghost" size="sm" className="h-9 px-3 text-xs shrink-0" onClick={scanConflicts} disabled={conflictsLoading}>
                             {recovered ? t('ui.rescan') : t('ui.retry')}
                          </Button>
                        </div>
                      )
                    })()}

                    {/* Stale results banner — INI changed since last scan */}
                    {conflictsStale && !conflictsLoading && (
                      <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 flex items-center gap-2 text-xs">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-warning" aria-hidden="true" />
                        <span className="flex-1 text-muted-foreground">{t('yourModListChangedSinceThisScanResultsMayBeOutdated')}</span>
                        <Button variant="outline" size="sm" className="h-9 px-3 text-xs shrink-0" onClick={scanConflicts} disabled={conflictsLoading}>
                           {t('ui.rescan')}
                        </Button>
                      </div>
                    )}

                    {/* Mod ID collisions — multiple workshop items declare the same internal mod id */}
                    {(conflicts.idCollisions?.filter(c => c.active).length ?? 0) > 0 && (
                      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                        <div className="flex items-start gap-2 text-xs">
                          <ShieldAlert className="w-4 h-4 shrink-0 text-destructive mt-0.5" aria-hidden="true" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-destructive">
                               {t('ui.modIdCollision', { count: conflicts.idCollisions!.filter(c => c.active).length })}
                            </p>
                            <p className="text-muted-foreground mt-0.5 leading-relaxed">
                               {t('ui.pzWillLoadOnlyOne')}
                            </p>
                          </div>
                        </div>
                        <div className="space-y-1.5 pl-6">
                          {conflicts.idCollisions!.filter(c => c.active).map(coll => (
                            <div key={coll.modId} className="text-[11px] flex items-baseline gap-2 flex-wrap">
                              <code className="font-mono px-1.5 py-0.5 rounded bg-destructive/10 text-destructive font-medium shrink-0">{coll.modId}</code>
                              <span className="text-muted-foreground">{t('declaredBy')}</span>
                              {coll.sources.map((s, i) => (
                                <span key={s.workshopId} className="inline-flex items-center gap-1 text-foreground/80">
                                  <a
                                    href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${s.workshopId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="hover:underline truncate max-w-[200px]"
                                    title={`${s.modName} (Workshop #${s.workshopId})`}
                                  >
                                    {s.modName}
                                  </a>
                                  {i < coll.sources.length - 1 && <span className="text-muted-foreground/50">·</span>}
                                </span>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ─── Verdict hero ───
                        Headline number must match the active severity tab so
                        users don't see "6 conflicts found" while a tab labelled
                        "Real 1" is selected. We derive `headlineCount` from the
                        active filter and pick a label that fits. */}
                    {(() => {
                      const f = pairSeverityFilter
                      const headlineCount = (
                        f === 'all' ? severityCounts.all
                        : f === 'real' ? severityCounts.real
                        : f === 'high' ? severityCounts.high
                        : f === 'medium' ? severityCounts.medium
                        : severityCounts.low
                      ) ?? 0
                       const headlineLabel = f === 'all'
                         ? t('ui.overlappingPairsLabel')
                         : f === 'real' ? t('ui.realConflictsLabel')
                         : f === 'high' ? t('ui.criticalConflictsLabel')
                         : f === 'medium' ? t('ui.mediumConflictsLabel')
                         : t('ui.lowSeverityOverlapLabel')
                      const tone = headlineCount > 0 && (f === 'real' || f === 'high' || f === 'medium')
                        ? 'warning'
                        : headlineCount > 0
                          ? 'muted'
                          : 'success'
                      const isWarn = tone === 'warning'
                      const isSuccess = tone === 'success'
                      return (
                    conflicts.modsScanned > 0 ? (
                      <div
                        className={`relative rounded-lg border overflow-hidden ${
                          isWarn ? 'border-warning/30 bg-warning/[0.04]'
                            : isSuccess ? 'border-success/30 bg-success/[0.04]'
                            : 'border-border/40 bg-muted/[0.04]'
                        }`}
                        role="status"
                        aria-live="polite"
                      >
                        {/* Severity stripe — left edge accent */}
                        <div className={`absolute inset-y-0 left-0 w-1 ${isWarn ? 'bg-warning/60' : isSuccess ? 'bg-success/60' : 'bg-muted-foreground/40'}`} aria-hidden="true" />

                        <div className="flex items-stretch">
                          {/* Headline — big number + label */}
                          <div className="flex items-center gap-3.5 px-4 py-3 flex-1 min-w-0">
                            {isWarn ? (
                              <FileWarning className="w-5 h-5 text-warning shrink-0" aria-hidden="true" />
                            ) : isSuccess ? (
                              <CheckCircle className="w-5 h-5 text-success shrink-0" aria-hidden="true" />
                            ) : (
                              <Info className="w-5 h-5 text-muted-foreground shrink-0" aria-hidden="true" />
                            )}
                            <div className="flex items-baseline gap-2 min-w-0">
                              <span
                                className={`text-2xl font-semibold leading-none tabular-nums ${
                                  isWarn ? 'text-warning' : isSuccess ? 'text-success' : 'text-foreground/80'
                                }`}
                              >
                                {headlineCount}
                              </span>
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-foreground/90 leading-tight">
                                   {headlineCount > 0 ? headlineLabel : t('ui.noConflictsInView')}
                                </p>
                                <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                                   {f === 'all' || f === 'low'
                                     ? t('ui.severitySummary', { real: severityCounts.real, low: severityCounts.low, mods: conflicts.modsScanned })
                                     : t('ui.overlapSummary', { total: severityCounts.all, mods: conflicts.modsScanned })}
                                </p>
                              </div>
                            </div>
                            {dedupedDepCount > 0 && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    onClick={() => setConflictSubTab('dependencies')}
                                    className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/15 transition-colors shrink-0"
                                  >
                                    <GitBranch className="w-3 h-3" aria-hidden="true" />
                                    {t('ui.missingDepsCount', { count: dedupedDepCount })}
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="text-xs max-w-xs">
                                  <p>{t('modsThatRequireOtherModsNotInYourServerConfig')}</p>
                                  <p className="text-muted-foreground mt-0.5">{t('clickToViewDetailsAndFixThem')}</p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>

                          {/* Scan stats strip — right side */}
                          <div className="flex items-center gap-4 border-l border-border/30 px-4 py-3 text-[11px] bg-background/30">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="text-center cursor-help">
                                  <div className="tabular-nums font-semibold text-foreground/80 leading-none">{conflicts.modsScanned}</div>
                                  <div className="text-muted-foreground mt-1 leading-none">{t('scanned')}</div>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="text-xs max-w-xs space-y-0.5">
                                <p>{t('ui.scannedModsCompared', { count: conflicts.modsScanned })}</p>
                                {(conflicts.modsSkippedInactive ?? 0) > 0 && <p className="text-muted-foreground">{t('ui.modsSkippedInactive', { count: conflicts.modsSkippedInactive })}</p>}
                                {(conflicts.modsNotFound ?? 0) > 0 && <p className="text-muted-foreground">{t('ui.modsNotFound', { count: conflicts.modsNotFound })}</p>}
                              </TooltipContent>
                            </Tooltip>
                            {(conflicts.modsNotFound ?? 0) > 0 && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="text-center cursor-help">
                                    <div className="tabular-nums font-semibold text-muted-foreground leading-none">{conflicts.modsNotFound}</div>
                                    <div className="text-muted-foreground mt-1 leading-none">{t('notOnDisk')}</div>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="text-xs max-w-xs">
                                  {t('ui.untrackedModsTooltip')}
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {(conflicts.identicalSkipped ?? 0) > 0 && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="text-center cursor-help opacity-70">
                                    <div className="tabular-nums font-medium text-success/70 leading-none text-[11px]">{conflicts.identicalSkipped}</div>
                                    <div className="text-muted-foreground/70 mt-1 leading-none text-[10px]">{t('identical')}</div>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="text-xs max-w-xs">
                                  {t('ui.identicalFilesSkipped', { count: conflicts.identicalSkipped })}
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {((conflicts.additiveSkipped ?? 0) + (conflicts.pzAdditiveSkipped ?? 0)) > 0 && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="text-center cursor-help opacity-70">
                                    <div className="tabular-nums font-medium text-success/70 leading-none text-[11px]">{(conflicts.additiveSkipped ?? 0) + (conflicts.pzAdditiveSkipped ?? 0)}</div>
                                    <div className="text-muted-foreground/70 mt-1 leading-none text-[10px]">{t('additive')}</div>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="text-xs space-y-0.5">
                                  <p className="font-medium mb-1">{t('filesPzMergesAutomaticallyNotRealConflicts')}</p>
                                  {(conflicts.pzAdditiveBreakdown?.sandbox ?? 0) > 0 && <p>{t('ui.sandboxFiles', { count: conflicts.pzAdditiveBreakdown!.sandbox })}</p>}
                                  {(conflicts.pzAdditiveBreakdown?.translate ?? 0) + (conflicts.additiveSkipped ?? 0) > 0 && <p>{t('ui.translationFiles', { count: (conflicts.pzAdditiveBreakdown?.translate ?? 0) + (conflicts.additiveSkipped ?? 0) })}</p>}
                                  {(conflicts.pzAdditiveBreakdown?.scripts ?? 0) > 0 && <p>{t('ui.scriptFiles', { count: conflicts.pzAdditiveBreakdown!.scripts })}</p>}
                                  {(conflicts.pzAdditiveBreakdown?.clothing ?? 0) > 0 && <p>{t('ui.clothingXmls', { count: conflicts.pzAdditiveBreakdown!.clothing })}</p>}
                                  {(conflicts.pzAdditiveBreakdown?.fileguidtable ?? 0) > 0 && <p>{t('ui.modEditorMetadata', { count: conflicts.pzAdditiveBreakdown!.fileguidtable })}</p>}
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {(conflicts.warnings?.length ?? 0) > 0 && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="text-center cursor-help">
                                    <div className="tabular-nums font-semibold text-warning leading-none">{conflicts.warnings!.length}</div>
                                      <div className="text-warning/70 mt-1 leading-none">{t('ui.warnings', { count: conflicts.warnings!.length })}</div>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="max-w-xs text-xs space-y-0.5">
                                  {conflicts.warnings!.slice(0, 5).map((w, i) => <p key={i} className="break-words">{w}</p>)}
                                  {conflicts.warnings!.length > 5 && <p className="text-muted-foreground">{t('ui.moreItems', { count: conflicts.warnings!.length - 5 })}</p>}
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
                        <p className="text-xs text-muted-foreground flex items-center gap-2">
                          <Info className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                          {t('ui.noModsConfigured')}
                        </p>
                      </div>
                    )
                    )
                    })()}

                    {/* No conflicts — only when scanned and nothing found */}
                    {conflicts.modsScanned > 0 && conflicts.totalConflicts === 0 && dedupedDepCount === 0 && (
                      <div className="flex items-center justify-center py-8 text-muted-foreground scan-complete-flash">
                        <div className="text-center max-w-xs">
                          <CheckCircle className="w-8 h-8 mx-auto text-success/70 mb-2" aria-hidden="true" />
                          <p className="font-medium text-foreground text-sm">{t('noConflictsFound')}</p>
                          <p className="text-xs mt-1 text-muted-foreground">
                             {t('ui.scannedNoOverlap', { count: conflicts.modsScanned })}
                            {(conflicts.modsNotFound ?? 0) > 0 && (
                              <span className="block mt-0.5">
                                 {t('ui.modsNotDownloaded', { count: conflicts.modsNotFound })}
                              </span>
                            )}
                            {(conflicts.identicalSkipped ?? 0) > 0 && (
                              <span className="block mt-0.5">
                                 {t('ui.identicalFilesSkipped', { count: conflicts.identicalSkipped })}
                              </span>
                            )}
                            {(conflicts.additiveSkipped ?? 0) + (conflicts.pzAdditiveSkipped ?? 0) > 0 && (
                              <span className="block mt-0.5">
                                 {t('ui.additiveFilesSkipped', { count: (conflicts.additiveSkipped ?? 0) + (conflicts.pzAdditiveSkipped ?? 0) })}
                              </span>
                            )}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* ─── Inner sub-tabs: Network / Dependencies ─── */}
                    {(conflicts.totalConflicts > 0 || dedupedDepCount > 0) && (
                      <div>
                        {/* Sub-tab bar */}
                        <div className="flex items-center gap-1 border-b border-border/30 mb-3">
                          <button
                            onClick={() => setConflictSubTab('network')}
                            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                              conflictSubTab === 'network'
                                ? 'border-accent text-accent-foreground'
                                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border/50'
                            }`}
                          >
                            <Network className="w-3.5 h-3.5" />
                            {t('ui.fileOverlaps')}
                            {conflicts.totalPairs > 0 && (
                              <Badge variant="secondary" className="text-[11px] h-4 px-1 ml-0.5">{conflicts.totalPairs}</Badge>
                            )}
                          </button>
                          <button
                            onClick={() => setConflictSubTab('dependencies')}
                            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                              conflictSubTab === 'dependencies'
                                ? 'border-accent text-accent-foreground'
                                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border/50'
                            }`}
                          >
                            <GitBranch className="w-3.5 h-3.5" />
                            {t('ui.missingDependencies')}
                            {dedupedDepCount > 0 && (
                              <Badge variant="destructive" className="text-[11px] h-4 px-1 ml-0.5">{dedupedDepCount}</Badge>
                            )}
                          </button>
                        </div>

                        {/* ═══ NETWORK SUB-TAB ═══ */}
                        {conflictSubTab === 'network' && (
                          <div className="space-y-3">

                            {/* Severity filter tabs + pairs header */}
                            {(conflicts.pairs?.length ?? 0) > 0 && (() => {
                              const allPairKeys = filteredPairs.map(p => `${p.modA.modId}--${p.modB.modId}`)
                              const allExpanded = openPairs.length === allPairKeys.length && allPairKeys.length > 0
                              const sevFilteredTopMods = topConflictingMods
                                .map(m => {
                                  if (pairSeverityFilter === 'high') return { ...m, medium: 0, low: 0 }
                                  if (pairSeverityFilter === 'medium') return { ...m, high: 0, low: 0 }
                                  if (pairSeverityFilter === 'low') return { ...m, high: 0, medium: 0 }
                                  if (pairSeverityFilter === 'real') return { ...m, low: 0 }
                                  return m
                                })
                                .filter(m => (m.high + m.medium + m.low) > 0)
                              const visibleTopMods = showAllTopMods ? sevFilteredTopMods : sevFilteredTopMods.slice(0, 6)
                              const hiddenTopCount = sevFilteredTopMods.length - visibleTopMods.length
                              return (
                                <>
                                  <div className="rounded-lg border border-border/35 bg-card/35 px-3 py-2.5 space-y-2">
                                  <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                                    <div className="flex flex-wrap items-center gap-1">
                                      {[
                                        { key: 'real' as const, label: t('ui.real'), count: severityCounts.real, dot: 'bg-warning', color: 'text-warning' },
                                        { key: 'high' as const, label: t('ui.critical'), count: severityCounts.high, dot: 'bg-destructive', color: 'text-destructive' },
                                        { key: 'medium' as const, label: t('ui.medium'), count: severityCounts.medium, dot: 'bg-warning', color: 'text-warning' },
                                        { key: 'low' as const, label: t('ui.low'), count: severityCounts.low, dot: 'bg-primary/60', color: 'text-primary/70' },
                                        { key: 'all' as const, label: t('ui.all'), count: severityCounts.all, dot: null },
                                      ].map(tab => (
                                        <button
                                          key={tab.key}
                                          onClick={() => setPairSeverityFilter(tab.key)}
                                          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                                            pairSeverityFilter === tab.key
                                              ? 'bg-accent text-accent-foreground'
                                              : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                                          }`}
                                          title={tab.key === 'real' ? t('ui.criticalMediumDesc') : tab.key === 'all' ? t('ui.allPairsDesc') : undefined}
                                        >
                                          {tab.dot && <span className={`w-1.5 h-1.5 rounded-full ${tab.dot}`} aria-hidden="true" />}
                                          {tab.label}
                                          <span className={`tabular-nums ${pairSeverityFilter === tab.key ? '' : tab.color || ''}`}>{tab.count}</span>
                                        </button>
                                      ))}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <div className="relative">
                                        <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" aria-hidden="true" />
                                        <input
                                          type="text"
                                          value={pairSearchQuery}
                                          onChange={(e) => setPairSearchQuery(e.target.value)}
                                          placeholder={t('filters.filterByName')}
                                          aria-label={t('labels.filterConflicts')}
                                          className="h-8 w-full min-w-[14rem] pl-6 pr-6 rounded-md text-[11px] bg-background/50 border border-border/40 focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent placeholder:text-muted-foreground/50 sm:w-56"
                                        />
                                        {pairSearchQuery && (
                                          <button
                                            type="button"
                                            onClick={() => setPairSearchQuery('')}
                                            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground text-[10px] leading-none"
                                            aria-label={t('labels.clearFilter')}
                                            title={t('filters.clearFilter')}
                                          >
                                            ×
                                          </button>
                                        )}
                                      </div>
                                      {graphFilterMod && (
                                        <button
                                          className="rounded border border-border/40 bg-muted/25 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                                          onClick={() => setGraphFilterMod(null)}
                                        >
                                          {t('labels.clearFilter')}
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  <details className="group/conflict-tools rounded border border-border/25 bg-muted/15 px-2 py-1.5">
                                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] text-muted-foreground hover:text-foreground">
                                      <span className="inline-flex items-center gap-1.5">
                                        <ChevronRight className="h-3 w-3 transition-transform group-open/conflict-tools:rotate-90" aria-hidden="true" />
                                        {t('ui.triageControls')}
                                      </span>
                                      <span className="font-mono text-[10px] text-muted-foreground/65">
                                        {groupByWinner ? t('ui.grouped') : t('ui.flat')} · {openPairs.length} {t('ui.open')}
                                      </span>
                                    </summary>
                                    <div className="mt-2 space-y-2 border-t border-border/25 pt-2">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <button
                                          type="button"
                                          onClick={() => setGroupByWinner(v => !v)}
                                          className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
                                            groupByWinner
                                              ? 'border-accent/40 bg-accent/10 text-accent-foreground'
                                              : 'border-border/40 text-muted-foreground hover:text-foreground hover:bg-muted/20'
                                          }`}
                                          title={t('actions.collapsePairs')}
                                        >
                                          <Layers className="w-3 h-3" aria-hidden="true" />
                                          {t('ui.groupByWinner')}
                                        </button>
                                        <button
                                          type="button"
                                          className="rounded border border-border/40 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/20 hover:text-foreground transition-colors"
                                          onClick={() => setOpenPairs(allExpanded ? [] : allPairKeys)}
                                        >
                                          {allExpanded ? t('ui.collapseAllPairs') : t('ui.expandAllPairs')}
                                        </button>
                                        <button
                                          type="button"
                                          className="rounded border border-border/40 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/20 hover:text-foreground transition-colors"
                                          onClick={() => setShowAllTopMods(v => !v)}
                                          disabled={hiddenTopCount <= 0 && !showAllTopMods}
                                        >
                                          {showAllTopMods ? t('ui.showFewerTopMods') : t('ui.showMoreTopMods', { count: Math.max(hiddenTopCount, 0) })}
                                        </button>
                                      </div>
                                      {sevFilteredTopMods.length > 0 && (
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          {visibleTopMods.map((mod) => {
                                            const isSelected = graphFilterMod === mod.modId
                                            const total = mod.high + mod.medium + mod.low
                                            return (
                                              <button
                                                key={mod.modId}
                                                onClick={() => setGraphFilterMod(isSelected ? null : mod.modId)}
                                                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                                                  isSelected
                                                    ? 'bg-accent/15 border-accent/40 text-accent-foreground'
                                                    : 'bg-muted/5 border-border/30 text-foreground/70 hover:bg-muted/20 hover:border-border/50'
                                                }`}
                                                title={`${mod.modName} — ${total} conflict${total !== 1 ? 's' : ''} (${mod.high}H ${mod.medium}M ${mod.low}L) across ${mod.pairs} pair${mod.pairs !== 1 ? 's' : ''}`}
                                              >
                                                <span className="max-w-[150px] truncate">{mod.modName}</span>
                                                <span className="shrink-0 font-mono tabular-nums text-[10px] text-muted-foreground/80">{total}</span>
                                              </button>
                                            )
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  </details>
                                  </div>

                                  {/* Pairs list */}
                                  {filteredPairs.length > 0 ? (
                                    <div className="max-h-[min(calc(100vh-420px),70vh)] min-h-[200px] overflow-y-auto rounded-lg border border-border/20 pr-1">
                                      <div className="p-1.5 space-y-2">
                                        {(groupByWinner
                                          ? groupedPairs
                                          : [{ key: '__flat__', name: '', modId: null, pairs: filteredPairs }]
                                        ).map((__group) => (
                                          <div key={__group.key}>
                                            {groupByWinner && groupedPairs.length > 1 && (
                                              <div className="px-2 pt-1 pb-1.5 flex items-baseline gap-2 text-[11px]">
                                                <CheckCircle className="w-3 h-3 text-success/70 self-center shrink-0" aria-hidden="true" />
                                                <span className={`font-semibold truncate ${__group.key.startsWith('__') ? 'text-muted-foreground' : 'text-foreground/85'}`} title={__group.name}>
                                                  {__group.name || t('ui.pairs')}
                                                </span>
                                                <span className="text-muted-foreground/70 shrink-0">
                                                  {t('ui.winsPairsCount', { count: __group.pairs.length })}
                                                </span>
                                              </div>
                                            )}
                                            <Accordion type="multiple" value={openPairs} onValueChange={setOpenPairs} className="space-y-1.5">
                                              {__group.pairs.map((pair, pairIdx) => {
                                          const pairKey = `${pair.modA.modId}--${pair.modB.modId}`
                                          const totalFiles = pair.files.length
                                          const showAll = expandedFilePairs.has(pairKey)
                                          const visibleFiles = showAll ? pair.files : pair.files.slice(0, CONFLICT_FILE_LIMIT)
                                          const hiddenCount = showAll ? 0 : totalFiles - Math.min(totalFiles, CONFLICT_FILE_LIMIT)
                                          const maxSeverity = pair.highCount > 0 ? 'high' : pair.mediumCount > 0 ? 'medium' : 'low'
                                          const posA = loadOrderMap.get(pair.modA.modId)
                                          const posB = loadOrderMap.get(pair.modB.modId)
                                          const winner = posA != null && posB != null ? (posA > posB ? 'A' : posB > posA ? 'B' : null) : null
                                          return (
                                            <AccordionItem key={pairKey} value={pairKey} className={`border rounded-lg px-0 overflow-hidden border-l-[3px] conflict-pair-enter ${
                                              maxSeverity === 'high' ? 'border-l-destructive/60 bg-destructive/[0.02]' : maxSeverity === 'medium' ? 'border-l-warning/50' : 'border-l-primary/40'
                                            }`} style={{ animationDelay: `${Math.min(pairIdx * 50, 400)}ms` }}>
                                              <AccordionTrigger className="px-3 py-2.5 hover:no-underline hover:bg-muted/20 [&[data-state=open]]:bg-muted/15 transition-colors">
                                                <div className="flex min-w-0 flex-1 flex-col gap-2 text-left sm:flex-row sm:items-center sm:gap-3">
                                                  <div className={`w-2 h-2 rounded-full shrink-0 ${
                                                    maxSeverity === 'high' ? 'bg-destructive severity-pulse' : maxSeverity === 'medium' ? 'bg-warning' : 'bg-primary/60'
                                                  }`} aria-hidden="true" />
                                                  <span className="sr-only">{t('ui.severityConflict', { severity: maxSeverity })}:</span>

                                                  {(() => {
                                                    const aw = pair.aWins ?? 0
                                                    const bw = pair.bWins ?? 0
                                                    const tp = pair.thirdPartyWins ?? 0
                                                    const uk = pair.unknownWins ?? 0
                                                    const aWinsAll = aw > 0 && bw === 0 && tp === 0 && uk === 0
                                                    const bWinsAll = bw > 0 && aw === 0 && tp === 0 && uk === 0
                                                    const tpWinsAll = tp > 0 && aw === 0 && bw === 0
                                                    const thirdPartyName = tp > 0
                                                      ? pair.files.find(f => f.winner && f.winner.modId !== pair.modA.modId && f.winner.modId !== pair.modB.modId)?.winner?.modName
                                                      : null
                                                    const fallbackWinnerSide = aw === 0 && bw === 0 && tp === 0 && uk === 0 ? winner : null

                                                    // Mod name pill — gets a subtle "winner" highlight when this mod wins all files
                                                    const modPill = (mod: typeof pair.modA, pos: number | undefined, isWinner: boolean, isLoser: boolean) => (
                                                      <div className={`flex flex-col min-w-0 max-w-[44%] flex-1 px-2 py-1 rounded transition-colors ${
                                                        isWinner ? 'bg-success/10 border border-success/25' : isLoser ? 'opacity-60' : ''
                                                      }`} title={pos != null ? `${mod.modName} — load order #${pos}` : mod.modName}>
                                                        <span className={`truncate text-sm font-medium leading-tight ${isLoser ? 'line-through decoration-muted-foreground/40' : 'text-foreground/90'}`}>
                                                          {mod.modName}
                                                        </span>
                                                        {isWinner && (
                                                          <span className="text-[10px] leading-none mt-0.5 text-success/80">
                                                            {t('ui.loadsLater')}
                                                          </span>
                                                        )}
                                                      </div>
                                                    )

                                                    return (
                                                      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                                                        {modPill(pair.modA, posA, aWinsAll || fallbackWinnerSide === 'A', bWinsAll || fallbackWinnerSide === 'B')}
                                                        <ArrowRight className={`w-3.5 h-3.5 shrink-0 ${
                                                          aWinsAll || fallbackWinnerSide === 'A' ? 'text-success/60 -scale-x-100' : bWinsAll || fallbackWinnerSide === 'B' ? 'text-success/60' : 'text-muted-foreground/40'
                                                        } hidden sm:block`} aria-hidden="true" />
                                                        {modPill(pair.modB, posB, bWinsAll || fallbackWinnerSide === 'B', aWinsAll || fallbackWinnerSide === 'A')}

                                                        {/* Verdict pill on the right */}
                                                        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ml-auto sm:flex-nowrap">
                                                          {/* File count + severity dots */}
                                                          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted/30 border border-border/30">
                                                            <span className="text-[11px] tabular-nums font-medium text-foreground/80">
                                                              {totalFiles}
                                                            </span>
                                                            <span className="text-[10px] text-muted-foreground/70">{t('ui.filesCount', { count: totalFiles })}</span>
                                                            {(pair.highCount > 0 || pair.mediumCount > 0 || pair.lowCount > 0) && (
                                                              <span className="flex items-center gap-0.5 ml-1 pl-1.5 border-l border-border/40">
                                                                {pair.highCount > 0 && (
                                                                  <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-destructive/80">
                                                                    <span className="w-1 h-1 rounded-full bg-destructive" aria-hidden="true" />
                                                                    {pair.highCount}
                                                                  </span>
                                                                )}
                                                                {pair.mediumCount > 0 && (
                                                                  <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-warning/80">
                                                                    <span className="w-1 h-1 rounded-full bg-warning" aria-hidden="true" />
                                                                    {pair.mediumCount}
                                                                  </span>
                                                                )}
                                                                {pair.lowCount > 0 && (
                                                                  <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-primary/70">
                                                                    <span className="w-1 h-1 rounded-full bg-primary/60" aria-hidden="true" />
                                                                    {pair.lowCount}
                                                                  </span>
                                                                )}
                                                              </span>
                                                            )}
                                                          </div>

                                                          {/* Verdict badge */}
                                                          {tpWinsAll ? (
                                                            <Tooltip>
                                                              <TooltipTrigger asChild>
                                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-muted-foreground/20 text-muted-foreground cursor-help">
                                                                  {thirdPartyName ? t('ui.thirdPartyWins', { name: thirdPartyName }) : t('ui.thirdModWins')}
                                                                </span>
                                                              </TooltipTrigger>
                                                              <TooltipContent side="left" className="text-xs max-w-xs">
                                                                  {t('ui.thirdModOverrides', { modA: pair.modA.modName, modB: pair.modB.modName })}
                                                              </TooltipContent>
                                                            </Tooltip>
                                                          ) : aWinsAll || bWinsAll ? (
                                                            (pair.highCount > 0 || pair.mediumCount > 0) ? (
                                                              <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-warning/30 bg-warning/10 text-warning cursor-help">
                                                                    <FileWarning className="w-3 h-3" aria-hidden="true" />
                                                                    {t('ui.decided')}
                                                                  </span>
                                                                </TooltipTrigger>
                                                                <TooltipContent side="left" className="text-xs max-w-xs">
                                                                  {t('ui.loadOrderPicksWinner')}
                                                                </TooltipContent>
                                                              </Tooltip>
                                                            ) : (
                                                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-success/30 bg-success/10 text-success">
                                                                <CheckCircle className="w-3 h-3" aria-hidden="true" />
                                                                {t('ui.clean')}
                                                              </span>
                                                            )
                                                          ) : (aw > 0 || bw > 0 || tp > 0 || uk > 0) ? (
                                                            <Tooltip>
                                                              <TooltipTrigger asChild>
                                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-warning/30 bg-warning/10 text-warning cursor-help tabular-nums">
                                                                  {t('ui.mixedSummary', {
                                                                    aW: aw,
                                                                    bW: bw,
                                                                    thirdSuffix: tp > 0 ? `+${tp}` : '',
                                                                    unknownSuffix: uk > 0 ? `?${uk}` : '',
                                                                  })}
                                                                </span>
                                                              </TooltipTrigger>
                                                              <TooltipContent side="left" className="text-xs max-w-xs">
                                                                {t('ui.mixedTooltip', {
                                                                  modA: pair.modA.modName,
                                                                  aW: aw,
                                                                  modB: pair.modB.modName,
                                                                  bW: bw,
                                                                  third: tp,
                                                                  thirdSuffix: tp > 0 ? t('ui.thirdPartyTaken', { count: tp }) : '',
                                                                  unknownSuffix: uk > 0 ? t('ui.unknownFiles', { count: uk }) : '',
                                                                })}
                                                              </TooltipContent>
                                                            </Tooltip>
                                                          ) : null}
                                                        </div>
                                                      </div>
                                                    )
                                                  })()}
                                                </div>
                                              </AccordionTrigger>
                                              <AccordionContent>
                                                <div className="px-4 pb-3 pt-1 space-y-1">
                                                  {/* Severity breakdown — shown in expanded detail */}
                                                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                                                    {pair.highCount > 0 && (
                                                      <Badge variant="destructive" className="text-[11px] leading-none h-[18px] px-1.5">{t('ui.highLuaScripts', { count: pair.highCount })}</Badge>
                                                    )}
                                                    {pair.mediumCount > 0 && (
                                                      <Badge variant="warning" className="text-[11px] leading-none h-[18px] px-1.5">{t('ui.medItemsConfigs', { count: pair.mediumCount })}</Badge>
                                                    )}
                                                    {pair.lowCount > 0 && (
                                                      <Badge variant="secondary" className="text-[11px] leading-none h-[18px] px-1.5 border-primary/20 text-primary">{t('ui.lowCosmetic', { count: pair.lowCount })}</Badge>
                                                    )}
                                                    <span className="text-[11px] text-muted-foreground/70">
                                                      {hiddenCount > 0
                                                        ? t('ui.shownHidden', { shown: visibleFiles.length, hidden: hiddenCount })
                                                        : t('ui.shownOnly', { shown: visibleFiles.length })}
                                                    </span>

                                                    {/* Fix-it actions: promote one mod over the other in load order. */}
                                                    {posA != null && posB != null && (
                                                      <div className="ml-auto flex items-center gap-1.5 flex-wrap">
                                                        <Button
                                                          size="sm"
                                                          variant="outline"
                                                          className="h-7 px-2 text-[11px] gap-1"
                                                          disabled={savingModOrder || posA > posB}
                                                          title={posA > posB ? t('ui.alreadyLoadsLast', { name: pair.modA.modName }) : t('ui.moveAfter', { name: pair.modA.modName, other: pair.modB.modName })}
                                                          onClick={(e) => {
                                                            e.stopPropagation()
                                                            promoteModOverOpponent(pair.modA.modId, pair.modA.modName, pair.modB.modId, pair.modB.modName)
                                                          }}
                                                        >
                                                          <Wrench className="w-3 h-3" />
                                                          <span className="truncate max-w-[140px]">{t('makeAWin')}</span>
                                                        </Button>
                                                        <Button
                                                          size="sm"
                                                          variant="outline"
                                                          className="h-7 px-2 text-[11px] gap-1"
                                                          disabled={savingModOrder || posB > posA}
                                                          title={posB > posA ? t('ui.alreadyLoadsLast', { name: pair.modB.modName }) : t('ui.moveAfter', { name: pair.modB.modName, other: pair.modA.modName })}
                                                          onClick={(e) => {
                                                            e.stopPropagation()
                                                            promoteModOverOpponent(pair.modB.modId, pair.modB.modName, pair.modA.modId, pair.modA.modName)
                                                          }}
                                                        >
                                                          <Wrench className="w-3 h-3" />
                                                          <span className="truncate max-w-[140px]">{t('makeBWin')}</span>
                                                        </Button>
                                                        <Button
                                                          size="sm"
                                                          variant="ghost"
                                                          className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                                                          title={t('ui.conflictDetailsFor', { name: pair.modA.modName })}
                                                          onClick={(e) => { e.stopPropagation(); setModDetailsId(pair.modA.modId) }}
                                                        >
                                                          <Info className="w-3 h-3" /> {t('view.detailsA')}
                                                        </Button>
                                                        <Button
                                                          size="sm"
                                                          variant="ghost"
                                                          className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                                                          title={t('ui.conflictDetailsFor', { name: pair.modB.modName })}
                                                          onClick={(e) => { e.stopPropagation(); setModDetailsId(pair.modB.modId) }}
                                                        >
                                                          <Info className="w-3 h-3" /> {t('view.detailsB')}
                                                        </Button>
                                                      </div>
                                                    )}
                                                  </div>
                                                  {visibleFiles.map((f) => {
                                                    const winnerName = f.winner?.modId === pair.modA.modId
                                                      ? pair.modA.modName
                                                      : f.winner?.modId === pair.modB.modId
                                                      ? pair.modB.modName
                                                      : null
                                                    const loserName = winnerName == null
                                                      ? null
                                                      : winnerName === pair.modA.modName
                                                      ? pair.modB.modName
                                                      : pair.modA.modName
                                                    return (
                                                      <FileDiffViewer
                                                        key={`${pair.modA.modId}--${pair.modB.modId}--${f.file}`}
                                                        file={f.file}
                                                        modAId={pair.modA.modId}
                                                        modBId={pair.modB.modId}
                                                        modAName={pair.modA.modName}
                                                        modBName={pair.modB.modName}
                                                        severity={f.severity}
                                                        categoryLabel={f.categoryLabel}
                                                        winnerName={winnerName}
                                                        loserName={loserName}
                                                        overlap={f.overlap}
                                                      />
                                                    )
                                                  })}
                                                  {hiddenCount > 0 && (
                                                    <button
                                                      onClick={() => setExpandedFilePairs(prev => {
                                                        const next = new Set(prev)
                                                        next.add(pairKey)
                                                        return next
                                                      })}
                                                      className="text-[11px] text-muted-foreground/70 hover:text-foreground text-center pt-2 w-full transition-colors"
                                                    >
                                                      {t('ui.showMoreFiles', { count: hiddenCount })}
                                                    </button>
                                                  )}
                                                </div>
                                              </AccordionContent>
                                            </AccordionItem>
                                          )
                                        })}
                                            </Accordion>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-center py-4 text-xs text-muted-foreground">
                                      {t('ui.noPairsMatchFilter')}
                                    </div>
                                  )}
                                </>
                              )
                            })()}



                          </div>
                        )}

                        {/* ═══ DEPENDENCIES SUB-TAB ═══ */}
                        {conflictSubTab === 'dependencies' && (() => {
                          const rows = depRows
                          const missingRaw = conflicts?.missingDeps || []
                          const steamRaw = conflicts?.steamDeps || []

                          if (missingRaw.length === 0 && steamRaw.length === 0) {
                            return (
                              <div className="flex items-center justify-center py-10 text-muted-foreground">
                                <div className="text-center max-w-xs">
                                  <CheckCircle className="w-8 h-8 mx-auto text-success/70 mb-2" aria-hidden="true" />
                                  <p className="font-medium text-foreground text-sm">{t('allDependenciesSatisfied')}</p>
                                  <p className="text-xs mt-1 text-muted-foreground">{t('everyModsRequiredDependenciesArePresentInYourServerConfig')}</p>
                                </div>
                              </div>
                            );
                          }

                          const handleAddDep = async (workshopId: string, modId: string, key: string) => {
                            if (busyRef.current) return
                            busyRef.current = true
                            setDepAdding(prev => [...prev, key]);
                            try {
                              await modsApi.addMissingDep(workshopId, modId);
                              setDepAddResults(prev => ({ ...prev, [key]: 'added' as const }));
                            } catch {
                              setDepAddResults(prev => ({ ...prev, [key]: 'error' as const }));
                            } finally {
                              setDepAdding(prev => prev.filter(k => k !== key));
                              busyRef.current = false
                            }
                          };

                          // Undo a recently-added dependency — removes the mod
                          // from tracking + server config and flips the row back
                          // to its actionable state. Useful when Add Resolved
                          // was clicked by accident.
                          const handleUndoDep = async (workshopId: string, key: string) => {
                            if (busyRef.current) return
                            busyRef.current = true
                            setDepAdding(prev => [...prev, key]);
                            try {
                              await modsApi.batchRemove([workshopId]);
                              setDepAddResults(prev => {
                                const next = { ...prev }
                                delete next[key]
                                return next
                              });
                              fetchData();
                              toast({ title: t('toast.removed'), description: t('toast.removedDesc') });
                            } catch (err) {
                              toast({
                                title: t('toast.undoFailed'),
                                description: err instanceof Error ? err.message : 'Could not remove the mod',
                                variant: 'destructive',
                              });
                            } finally {
                              setDepAdding(prev => prev.filter(k => k !== key));
                              busyRef.current = false
                            }
                          };

                          // Inline Workshop search for unresolved deps. Runs the
                          // smart server-side search (variant expansion + Steam
                          // QueryFiles) and caches results so re-opening is instant.
                          const runDepSearch = async (row: typeof rows[number], force = false) => {
                            const key = row.key
                            if (!force && depSearchData[key] && !depSearchData[key].error) return
                            setDepSearchData(prev => ({ ...prev, [key]: { loading: true, results: [], error: null, searchUrl: null } }))
                            try {
                              const res = await modsApi.searchWorkshopMods(row.depModId || row.depName, {
                                parentName: row.requiredBy,
                                parentWorkshopId: row.requiredByWsId,
                              })
                              setDepSearchData(prev => ({ ...prev, [key]: { loading: false, results: res.results || [], error: null, searchUrl: res.searchUrl, variantsTried: res.variantsTried, steamSearchEnabled: res.steamSearchEnabled } }))
                            } catch (err: any) {
                              setDepSearchData(prev => ({ ...prev, [key]: { loading: false, results: [], error: err?.message || t('ui.searchFailed'), searchUrl: null } }))
                            }
                          }
                          const toggleDepSearch = (row: typeof rows[number]) => {
                            const key = row.key
                            setDepSearchOpen(prev => {
                              const next = new Set(prev)
                              if (next.has(key)) { next.delete(key); return next }
                              next.add(key); return next
                            })
                            if (!depSearchData[key]) runDepSearch(row)
                          }

                          const addableRows = rows.filter(r => r.depWorkshopId && depAddResults[r.key] !== 'added')
                          const addedCount = rows.filter(r => depAddResults[r.key] === 'added').length

                          const handleFixAll = async () => {
                            if (addableRows.length === 0 || fixingAllDeps || busyRef.current) return
                            busyRef.current = true
                            setFixingAllDeps(true)
                            try {
                              await modsApi.addAllResolvedDeps(
                                addableRows.map(r => ({ workshopId: r.depWorkshopId!, modId: r.depModId || undefined }))
                              )
                              for (const r of addableRows) {
                                setDepAddResults(prev => ({ ...prev, [r.key]: 'added' as const }))
                              }
                            } catch (err) {
                              reportClientError(t('logic.failedToAddAllDependencies'), err)
                              for (const r of addableRows) {
                                setDepAddResults(prev => ({ ...prev, [r.key]: 'error' as const }))
                              }
                            }
                            finally { setFixingAllDeps(false); busyRef.current = false }
                          }

                          return (
                            <div className="space-y-3">
                              {/* Header with Fix All */}
                              <div className="flex items-center justify-between">
                                <span className="text-xs text-muted-foreground">
                                  {t('ui.missingCount', { count: rows.length })}
                                  {addableRows.length < rows.length - addedCount && (
                                    <span className="ml-1 text-warning/80">— {t('ui.unresolvedCount', { count: rows.length - addableRows.length - addedCount })}</span>
                                  )}
                                  {addedCount > 0 && <span className="text-success ml-1">({t('ui.addedCount', { count: addedCount })})</span>}
                                </span>
                                {addableRows.length > 0 && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleFixAll}
                                    disabled={fixingAllDeps}
                                    className="h-7 text-xs"
                                    title={addableRows.length < rows.length - addedCount
                                      ? t('ui.addableCount', { count: addableRows.length })
                                      : t('ui.addAllResolvable', { count: addableRows.length })}
                                  >
                                    {fixingAllDeps ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <PlusCircle className="w-3.5 h-3.5 mr-1.5" />}
                                    {t('ui.addResolvedCount', { count: addableRows.length })}
                                  </Button>
                                )}
                              </div>

                              {/* Flat list — one row per dependency. Added rows
                                  stay visible (with strikethrough) so users can
                                  undo an accidental add via the Remove button. */}
                              <div className="rounded-lg border border-border/30 overflow-hidden divide-y divide-border/20 max-h-[min(calc(100vh-380px),70vh)] min-h-[200px] overflow-y-auto">
                                {rows.map((row) => {
                                  const added = depAddResults[row.key] === 'added'
                                  const adding = depAdding.includes(row.key)
                                  const errored = depAddResults[row.key] === 'error'
                                  const searchOpen = depSearchOpen.has(row.key)
                                  const searchState = depSearchData[row.key]

                                  return (
                                    <div key={row.key} className={`transition-colors ${added ? 'bg-success/5' : 'bg-background/30 hover:bg-muted/10'}`}>
                                      <div className="flex items-center gap-3 px-4 py-2.5">
                                      {/* Status dot */}
                                      <span className={`w-2 h-2 rounded-full shrink-0 ${
                                        added ? 'bg-success' : row.depWorkshopId ? 'bg-warning' : 'bg-destructive'
                                      }`} />

                                      {/* Dep name + required-by (two-line) */}
                                      <div className="flex-1 min-w-0">
                                        <span className={`text-sm font-medium block truncate ${added ? 'text-success/80 line-through' : 'text-foreground/90'}`}>
                                          {row.depName}
                                        </span>
                        <span className="text-[11px] text-muted-foreground block truncate">
                                          {t('ui.requiredBy')}{' '}
                                          <a href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${row.requiredByWsId}`}
                                            target="_blank" rel="noopener noreferrer"
                                            className="text-muted-foreground/70 hover:text-foreground underline decoration-muted-foreground/30 hover:decoration-foreground/50 transition-colors"
                                          >{row.requiredBy}<span className="sr-only">{t('ui.opensInNewTab')}</span></a>
                                          {row.source === 'steam' && <span className="ml-1.5 text-accent/70">{t('viaWorkshop')}</span>}
                                        </span>
                                      </div>

                                      {/* Action */}
                                      <div className="shrink-0 flex items-center gap-1.5">
                                        {added ? (
                                          <>
                                            <span className="text-xs text-success flex items-center gap-1"><Check className="w-3.5 h-3.5" /> {t('view.added')}</span>
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <Button
                                                  variant="ghost"
                                                  size="iconDense"
                                                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                                  onClick={() => row.depWorkshopId && handleUndoDep(row.depWorkshopId, row.key)}
                                                  disabled={adding || !row.depWorkshopId}
                                                  aria-label={t('view.undoRemove', { name: row.depName })}
                                                >
                                                  {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                                </Button>
                                              </TooltipTrigger>
                                              <TooltipContent>{t('undoRemoveFromServer')}</TooltipContent>
                                            </Tooltip>
                                          </>
                                        ) : errored ? (
                                          <span className="text-xs text-destructive">{t('failed')}</span>
                                        ) : row.depWorkshopId ? (
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => handleAddDep(row.depWorkshopId!, row.depModId || '', row.key)}
                                            disabled={adding}
                                            className="h-7 px-2.5 text-xs"
                                          >
                                            {adding ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Plus className="w-3 h-3 mr-1" />}
                                             {t('ui.add')}
                                          </Button>
                                        ) : (
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => toggleDepSearch(row)}
                                            aria-expanded={searchOpen}
                                            aria-controls={`dep-search-${row.key}`}
                                            className="h-7 px-2.5 text-xs"
                                          >
                                            <Search className="w-3 h-3 mr-1" /> {searchOpen ? t('ui.hide') : t('actions.openWorkshop')}
                                          </Button>
                                        )}
                                        {row.depWorkshopId && (
                                          <a href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${row.depWorkshopId}`}
                                            target="_blank" rel="noopener noreferrer"
                                            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors p-1"
                                            title={t('actions.openWorkshop')}
                                            aria-label={t('labels.viewOnWorkshop')}>
                                            <ExternalLink className="w-3.5 h-3.5" />
                                          </a>
                                        )}
                                      </div>
                                      </div>

                                      {/* Inline candidate finder for unresolved deps */}
                                      {searchOpen && !row.depWorkshopId && !added && (
                                        <div id={`dep-search-${row.key}`} className="border-t border-border/20 bg-muted/20 px-4 py-3">
                                          {searchState?.loading ? (
                                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                              <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('view.searchSteamWorkshopFor', { name: row.depModId || row.depName })}
                                            </div>
                                          ) : searchState?.error ? (
                                            <div className="flex items-center justify-between gap-2 text-xs">
                                              <span className="text-destructive break-words">{t('view.searchFailed', { error: searchState.error })}</span>
                                              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => runDepSearch(row, true)}>{t('ui.retry')}</Button>
                                            </div>
                                          ) : searchState && searchState.results.length === 0 ? (
                                            <div className="space-y-2 text-xs">
                                              {searchState.steamSearchEnabled === false ? (
                                                <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-warning">
                                                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                                                  <span>
                                                    {t('ui.workshopSearchDisabled')}
                                                  </span>
                                                </div>
                                              ) : (
                                                <p className="text-muted-foreground">
                                                  {t('ui.noMatchesFound')}{' '}{searchState.variantsTried && searchState.variantsTried.length > 1 && (
                                                     <span className="text-muted-foreground/70">({t('ui.triedVariants', { variants: searchState.variantsTried.slice(0, 4).join(', ') })})</span>
                                                  )}
                                                </p>
                                              )}
                                              {searchState.searchUrl && (
                                                <a href={searchState.searchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent/80 hover:text-accent">
                                                  <ExternalLink className="w-3 h-3" /> {t('view.openWorkshopSearch')}
                                                </a>
                                              )}
                                            </div>
                                          ) : searchState && searchState.results.length > 0 ? (
                                            <div className="space-y-2">
                                              <p className="text-[11px] text-muted-foreground">
                                                {t('ui.possibleMatches', { count: searchState.results.length })}
                                              </p>
                                              {searchState.steamSearchEnabled === false && (
                                                <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning">
                                                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                                                  <span>
                                                    {t('ui.onlyLocalModsSearched')}
                                                  </span>
                                                </div>
                                              )}
                                              <ul className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                                                {searchState.results.map((hit) => {
                                                  const candidateKey = `${row.key}::${hit.workshopId}`
                                                  const candAdding = depAdding.includes(candidateKey)
                                                  const candAdded = depAddResults[candidateKey] === 'added'
                                                  const candErrored = depAddResults[candidateKey] === 'error'
                                                  return (
                                                    <li key={hit.workshopId} className="flex items-start gap-2 rounded-md border border-border/30 bg-background/50 px-2.5 py-2">
                                                      <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${hit.isDownloaded ? 'bg-success' : 'bg-accent/60'}`} aria-hidden="true" />
                                                      <div className="flex-1 min-w-0">
                                                        <div className="flex items-baseline gap-2 flex-wrap">
                                                          <a
                                                            href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${hit.workshopId}`}
                                                            target="_blank" rel="noopener noreferrer"
                                                            className="text-sm font-medium text-foreground/90 hover:text-foreground truncate"
                                                          >{hit.modName}</a>
                                                          {hit.modId && (
                                                            <code className="text-[10px] text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded">{hit.modId}</code>
                                                          )}
                                                          {hit.isDownloaded && <span className="text-[10px] text-success">{t('downloaded')}</span>}
                                                          {typeof hit.subscriberCount === 'number' && hit.subscriberCount > 0 && (
                                                            <span className="text-[10px] text-muted-foreground/70">{t('ui.subsCount', { count: hit.subscriberCount.toLocaleString() })}</span>
                                                          )}
                                                        </div>
                                                        {hit.description && (
                                                          <p className="text-[11px] text-muted-foreground/80 line-clamp-2 mt-0.5">{hit.description}</p>
                                                        )}
                                                      </div>
                                                      <div className="shrink-0">
                                                        {candAdded ? (
                                                          <span className="text-xs text-success flex items-center gap-1"><Check className="w-3.5 h-3.5" /> {t('view.added')}</span>
                                                        ) : candErrored ? (
                                                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => handleAddDep(hit.workshopId, hit.modId || row.depModId || '', candidateKey)}>{t('ui.retry')}</Button>
                                                        ) : (
                                                          <Button
                                                            variant="outline"
                                                            size="sm"
                                                            className="h-7 px-2.5 text-xs"
                                                            disabled={candAdding}
                                                            onClick={() => handleAddDep(hit.workshopId, hit.modId || row.depModId || '', candidateKey)}
                                                          >
                                                            {candAdding ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Plus className="w-3 h-3 mr-1" />}
                                                            {t('add')}
                                                          </Button>
                                                        )}
                                                      </div>
                                                    </li>
                                                  )
                                                })}
                                              </ul>
                                              {searchState.searchUrl && (
                                                <a href={searchState.searchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors">
                                                  <ExternalLink className="w-3 h-3" /> {t('view.notHereOpenWorkshop')}
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
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ─── Per-mod conflict details drawer ─── */}
            <Dialog open={modDetailsId != null} onOpenChange={(open) => { if (!open) setModDetailsId(null) }}>
              <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto sm:max-h-[80vh]">
                {(() => {
                  if (!modDetailsId || !conflicts) return null
                  const allPairs = conflicts.pairs ?? []
                  const myPairs = allPairs.filter(p => p.modA.modId === modDetailsId || p.modB.modId === modDetailsId)
                  if (myPairs.length === 0) {
                    return (
                      <>
                        <DialogHeader>
                          <DialogTitle>{t('noConflicts')}</DialogTitle>
                          <DialogDescription>{t('thisModHasNoRecordedConflictsInTheLatestScan')}</DialogDescription>
                        </DialogHeader>
                      </>
                    )
                  }
                  // Resolve display name from first pair we find
                  const firstHit = myPairs[0]
                  const modName = firstHit.modA.modId === modDetailsId ? firstHit.modA.modName : firstHit.modB.modName
                  const pos = loadOrderMap.get(modDetailsId)
                  // Tally wins/losses across pairs (based on load order)
                  let winsPairs = 0, losesPairs = 0, tiedPairs = 0
                  let totalFiles = 0
                  const extCounts = new Map<string, number>()
                  for (const p of myPairs) {
                    totalFiles += p.files.length
                    for (const f of p.files) {
                      const dot = f.file.lastIndexOf('.')
                      const ext = dot >= 0 ? f.file.slice(dot + 1).toLowerCase() : '(no ext)'
                      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1)
                    }
                    const myPos = loadOrderMap.get(modDetailsId)
                    const otherId = p.modA.modId === modDetailsId ? p.modB.modId : p.modA.modId
                    const otherPos = loadOrderMap.get(otherId)
                    if (myPos != null && otherPos != null) {
                      if (myPos > otherPos) winsPairs++
                      else if (myPos < otherPos) losesPairs++
                      else tiedPairs++
                    }
                  }
                  const topExts = Array.from(extCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)
                  const sortedPairs = [...myPairs].sort((a, b) =>
                    (b.highCount - a.highCount) || (b.mediumCount - a.mediumCount) || (b.files.length - a.files.length)
                  )

                  const jumpToPair = (pair: typeof myPairs[number]) => {
                    const key = `${pair.modA.modId}--${pair.modB.modId}`
                    setOpenPairs(prev => prev.includes(key) ? prev : [...prev, key])
                    setModDetailsId(null)
                    // Defer scroll until accordion has opened
                    setTimeout(() => {
                      const el = document.querySelector(`[data-state][value="${CSS.escape(key)}"]`) as HTMLElement | null
                      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    }, 120)
                  }

                  return (
                    <>
                      <DialogHeader>
                        <DialogTitle className="text-base flex items-center gap-2 min-w-0">
                          <Info className="w-4 h-4 shrink-0 text-accent" />
                          <span className="truncate">{modName}</span>
                          {pos != null && (
                            <span className="text-[11px] font-normal text-muted-foreground shrink-0">{t('ui.loadNum', { pos })}</span>
                          )}
                        </DialogTitle>
                         <DialogDescription>
                           {t('ui.pairsAndFiles', { pairs: myPairs.length, files: totalFiles })}
                           {(winsPairs > 0 || losesPairs > 0 || tiedPairs > 0) && (
                             <> · {t('ui.winsLosesTied', { wins: winsPairs, loses: losesPairs, tied: tiedPairs })}</>
                           )}
                         </DialogDescription>
                      </DialogHeader>

                      {topExts.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap pb-1 border-b border-border/30">
                          <span className="text-[11px] text-muted-foreground">{t('topFileTypes')}</span>
                          {topExts.map(([ext, count]) => (
                            <Badge key={ext} variant="secondary" className="text-[10px] h-5 px-1.5 tabular-nums">
                              .{ext} <span className="text-muted-foreground/80 ml-1">{count}</span>
                            </Badge>
                          ))}
                        </div>
                      )}

                      <ul className="space-y-1.5">
                        {sortedPairs.map((p) => {
                          const isA = p.modA.modId === modDetailsId
                          const other = isA ? p.modB : p.modA
                          const otherPos = loadOrderMap.get(other.modId)
                          const myPos = loadOrderMap.get(modDetailsId)
                          const winning = myPos != null && otherPos != null ? (myPos > otherPos ? 'win' : myPos < otherPos ? 'lose' : 'tie') : 'unknown'
                          const maxSev = p.highCount > 0 ? 'high' : p.mediumCount > 0 ? 'medium' : 'low'
                          return (
                            <li key={`${p.modA.modId}--${p.modB.modId}`}
                                className={`flex items-center gap-2 rounded-md border px-2.5 py-2 ${
                                  maxSev === 'high' ? 'border-destructive/40 bg-destructive/[0.03]' :
                                  maxSev === 'medium' ? 'border-warning/40 bg-warning/[0.03]' :
                                  'border-border/40'
                                }`}>
                              <span className={`w-2 h-2 rounded-full shrink-0 ${
                                maxSev === 'high' ? 'bg-destructive' : maxSev === 'medium' ? 'bg-warning' : 'bg-primary/60'
                              }`} aria-hidden="true" />
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium truncate">{other.modName}</div>
                                <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
                                  <span className="tabular-nums">{t('ui.filesCount', { count: p.files.length })}</span>
                                  {p.highCount > 0 && <span className="text-destructive/80 tabular-nums">{t('ui.highCount', { count: p.highCount })}</span>}
                                  {p.mediumCount > 0 && <span className="text-warning/80 tabular-nums">{t('ui.medCount', { count: p.mediumCount })}</span>}
                                  {p.lowCount > 0 && <span className="text-primary/70 tabular-nums">{t('ui.lowCount', { count: p.lowCount })}</span>}
                                  {otherPos != null && <span>{t('ui.loadNum', { pos: otherPos })}</span>}
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {winning === 'win' && (
                                  <Badge variant="secondary" className="text-[10px] h-5 px-1.5 border-success/30 bg-success/10 text-success">{t('ui.wins')}</Badge>
                                )}
                                {winning === 'lose' && (
                                  <Badge variant="secondary" className="text-[10px] h-5 px-1.5 border-warning/30 bg-warning/10 text-warning">{t('ui.loses')}</Badge>
                                )}
                                {winning === 'lose' && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 px-2 text-[10px] gap-1"
                                    disabled={savingModOrder}
                                    onClick={() => promoteModOverOpponent(modDetailsId, modName, other.modId, other.modName)}
                                  >
                                    <Wrench className="w-3 h-3" /> {t('view.winIt')}
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-[10px]"
                                  onClick={() => jumpToPair(p)}
                                >
                                  {t('ui.view')}
                                </Button>
                              </div>
                            </li>
                          )
                        })}
                      </ul>

                      <DialogFooter className="pt-2">
                        <Button variant="outline" size="sm" onClick={() => setModDetailsId(null)}>{t('ui.close')}</Button>
                      </DialogFooter>
                    </>
                  )
                })()}
              </DialogContent>
            </Dialog>
          </TabsContent>

          {/* ─── Collection Tab ─── */}
          <TabsContent value="collection" className="space-y-4">
            <WorkshopCollectionPanel />
          </TabsContent>

          {/* ─── Deactivated Tab ───
              Tracked mods that are no longer present in the active server INI's
              WorkshopItems= list. Kept tracked so you can re-enable them, but
              segregated from the live server view. */}
          <TabsContent value="deactivated" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <EyeOff className="w-4 h-4 text-muted-foreground" />
                  <CardTitle className="text-base">{t('ui.deactivatedMods')}</CardTitle>
                  <Badge variant="outline" className="font-mono text-[11px] tabular-nums">
                    {groupedMods.deactivated.length}
                  </Badge>
                </div>
                <CardDescription>
                  {t('ui.deactivatedDescription')}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {!iniConfig ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    {t('ui.loadingServerConfig')}
                  </div>
                ) : groupedMods.deactivated.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
                    <CheckCircle className="w-8 h-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">
                       {t('ui.noDeactivatedMods')}
                    </p>
                    <p className="text-xs text-muted-foreground/70 max-w-md">
                       {t('ui.everyTrackedModReferenced')}
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Toolbar: select-all / enable / delete bulk actions */}
                    {(() => {
                      const deactivatedIds = groupedMods.deactivated.map(m => m.workshop_id)
                      const selectedDeactivated = deactivatedIds.filter(id => selectedMods.has(id))
                      const allSelected = selectedDeactivated.length === deactivatedIds.length && deactivatedIds.length > 0
                      const someSelected = selectedDeactivated.length > 0
                      const missingNameCount = groupedMods.deactivated.filter(m => !m.name || /^Workshop Mod /i.test(m.name)).length
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
                                aria-label={t('labels.selectDeactivated')}
                              />
                              <span className="text-xs text-muted-foreground">
                                 {someSelected ? t('ui.selectedCount', { count: selectedDeactivated.length }) : t('ui.selectCount', { count: deactivatedIds.length })}
                              </span>
                            </div>
                            <div className="ml-auto flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!someSelected || loading}
                                onClick={() => handleBulkEnable(selectedDeactivated)}
                              >
                                <PlusCircle className="w-4 h-4 mr-1.5" />
                                 {someSelected ? t('ui.reenableCount', { count: selectedDeactivated.length }) : t('ui.reenable')}
                              </Button>
                            </div>
                          </div>
                          <details className="group/deactivated-danger rounded border border-border/35 bg-card/35 px-2.5 py-1.5">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] text-muted-foreground hover:text-foreground">
                              <span className="inline-flex items-center gap-1.5">
                                <ChevronRight className="h-3 w-3 transition-transform group-open/deactivated-danger:rotate-90" aria-hidden="true" />
                                 {t('ui.trackingCleanup')}
                              </span>
                              <span className="text-muted-foreground/65">{t('destructive')}</span>
                            </summary>
                            <div className="mt-2 flex flex-col gap-2 border-t border-border/25 pt-2 sm:flex-row sm:items-center sm:justify-between">
                              <p className="text-[11px] leading-4 text-muted-foreground">
                                 {t('ui.deleteFromTrackingDesc')}
                              </p>
                              <Button
                                variant="destructive"
                                size="sm"
                                className="self-start sm:self-auto"
                                disabled={loading || (deactivatedIds.length === 0)}
                                onClick={async () => {
                                  const ids = someSelected ? selectedDeactivated : deactivatedIds
                                   const label = someSelected
                                     ? t('ui.deleteSelectedDeactivatedConfirm', { count: ids.length })
                                     : t('ui.deleteAllDeactivatedConfirm', { count: ids.length })
                                  const ok = await confirm({ title: t('ui.deleteFromTrackingConfirm'), description: label, confirmLabel: t('toast.delete') })
                                  if (!ok) return
                                  setSelectedMods(new Set(ids))
                                  handleBulkRemove(ids)
                                }}
                              >
                                <Trash2 className="w-4 h-4 mr-1.5" />
                                 {someSelected ? t('ui.deleteSelectedCount', { count: selectedDeactivated.length }) : t('ui.deleteAllCount', { count: deactivatedIds.length })}
                              </Button>
                            </div>
                          </details>
                          {missingNameCount > 0 && (
                            <div className="flex items-start gap-2 rounded border border-border/40 bg-card/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                              <div className="flex-1 flex items-center gap-2 flex-wrap">
                                <span className="flex-1 min-w-0">
                                   {t('ui.genericNamesFound', { count: missingNameCount })}
                                </span>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 px-2 text-[11px]"
                                  disabled={loading}
                                  onClick={() => {
                                    const targets = groupedMods.deactivated
                                      .filter(m => !m.name || /^Workshop Mod /i.test(m.name))
                                      .map(m => m.workshop_id)
                                    handleRefreshNames(targets)
                                  }}
                                >
                                  <RefreshCw className={`w-3 h-3 mr-1 ${loading ? 'animate-spin' : ''}`} />
                                   {t('refreshNames')}
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Rows: per-row Enable + Delete; checkbox for bulk select */}
                    <div className="divide-y divide-border/30">
                      {groupedMods.deactivated.map(mod => {
                        const isSelected = selectedMods.has(mod.workshop_id)
                        return (
                          <div
                            key={mod.id}
                            className={`group/modrow flex items-center gap-3 px-3 py-2.5 border-l-2 border-muted-foreground/20 hover:bg-accent/40 transition-colors ${isSelected ? 'bg-accent/30' : ''}`}
                          >
                            <div className="shrink-0">
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() => toggleModSelect(mod.workshop_id)}
                              aria-label={t('view.selectMod', { name: mod.name || mod.workshop_id })}
                              />
                            </div>
                            <a
                              href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshop_id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 relative grid place-items-center w-16 h-16 rounded-md border border-border/50 bg-muted/30 text-muted-foreground overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          aria-label={t('view.openOnWorkshop', { name: mod.name || `${t('ui.workshopItemBadge')} ${mod.workshop_id}` })}
                              title={t('actions.openWorkshop')}
                            >
                              <Package className="w-7 h-7" aria-hidden="true" />
                              <img
                                src={demoMode ? `${import.meta.env.BASE_URL}spiffo.png` : `/api/mods/thumbnail/${mod.workshop_id}`}
                                alt=""
                                loading="lazy"
                                decoding="async"
                                className="absolute inset-0 w-full h-full object-cover rounded-md opacity-80"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                              />
                            </a>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="truncate text-sm font-medium text-foreground/90">
                                  {mod.name || t('logic.workshopMod', { id: mod.workshop_id })}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 flex-wrap mt-0.5 text-[11px] text-muted-foreground">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    copyText(mod.workshop_id).then(() => {
                                  toast({ title: t('toast.copied'), description: t('toast.copiedDesc', { workshopId: mod.workshop_id }) })
                                    }).catch(() => { /* no-op */ })
                                  }}
                                  className="inline-flex items-center gap-1 rounded border border-border/40 bg-muted/40 px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary transition-colors"
                                  aria-label={t('view.copyWorkshopId', { id: mod.workshop_id })}
                                >
                                  <span className="text-[9px] font-semibold uppercase tracking-wider opacity-70">{t('ws')}</span>
                                  <span>{mod.workshop_id}</span>
                                </button>
                                {mod.last_checked && (
                                  <span>{t('ui.checkedDate', { date: new Date(mod.last_checked).toLocaleDateString() })}</span>
                                )}
                              </div>
                            </div>
                            <div className="shrink-0 flex items-center gap-0.5">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <a
                                    href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.workshop_id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex"
                                  >
                                    <Button
                                      variant="ghost"
                                      size="iconDense"
                                      className="h-8 w-8 text-muted-foreground hover:text-primary"
                                      aria-label={t('labels.openWorkshopPage')}
                                    >
                                      <ExternalLink className="w-4 h-4" />
                                    </Button>
                                  </a>
                                </TooltipTrigger>
                                <TooltipContent>{t('openWorkshopPage')}</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="iconDense"
                                    className="h-8 w-8 text-muted-foreground hover:text-primary"
                                    onClick={() => handleEnableMod(mod.workshop_id)}
                                    disabled={loading}
                              aria-label={t('view.enableMod', { name: mod.name || mod.workshop_id })}
                                  >
                                    <PlusCircle className="w-4 h-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t('reenableAddBackToWorkshopitems')}</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="iconDense"
                                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                    onClick={() => setConfirmRemoveMod(mod.workshop_id)}
                                    disabled={loading}
                                aria-label={t('view.removeFromQueue', { name: mod.name || mod.workshop_id })}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t('deleteFromTracking')}</TooltipContent>
                              </Tooltip>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Single mod remove confirmation */}
      <AlertDialog open={!!confirmRemoveMod} onOpenChange={(open) => { if (!open) setConfirmRemoveMod(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeThisModFromTheServer')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('ui.removeModDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (confirmRemoveMod) handleRemoveMod(confirmRemoveMod); setConfirmRemoveMod(null) }}
            >
              {t('ui.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk remove confirmation */}
      <AlertDialog open={confirmBulkRemove} onOpenChange={setConfirmBulkRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ui.removeSelectedCount', { count: selectedMods.size })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('ui.removeModDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { handleBulkRemove(); setConfirmBulkRemove(false) }}
            >
              {t('ui.removeSelectedCount', { count: selectedMods.size })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}




