import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
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
  Map,
  Library,
  Search,
  Filter,
  Settings2,
  Power,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Info,
  Layers,
  Save,
  FolderOpen,
  Loader2,
  GripVertical
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { useToast } from '@/components/ui/use-toast'
import { modsApi } from '@/lib/api'

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
}

export default function Mods() {
  const [mods, setMods] = useState<TrackedMod[]>([])
  const [status, setStatus] = useState<ModStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const { toast } = useToast()

  // Search and filters
  const [searchQuery, setSearchQuery] = useState('')
  const [showUpdatesOnly, setShowUpdatesOnly] = useState(false)
  const [selectedMods, setSelectedMods] = useState<Set<string>>(new Set())

  // Advanced Add Mod dialog (with multi-ID selection)
  const [advancedAddOpen, setAdvancedAddOpen] = useState(false)
  const [advancedModInput, setAdvancedModInput] = useState('')
  const [discoveringMod, setDiscoveringMod] = useState(false)
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
  
  // INI configuration
  const [iniConfig, setIniConfig] = useState<IniConfig | null>(null)
  const [modsToInstall, setModsToInstall] = useState<CollectionMod[]>([])
  const [orderedModIds, setOrderedModIds] = useState<string[]>([])
  const [showModOrderEditor, setShowModOrderEditor] = useState(false)
  const [savingModOrder, setSavingModOrder] = useState(false)
  const [draggedModIndex, setDraggedModIndex] = useState<number | null>(null)  
  // Expand/collapse states
  const [showMapsExpanded, setShowMapsExpanded] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  
  // Restart settings dialog
  const [restartSettingsOpen, setRestartSettingsOpen] = useState(false)
  const [restartWarningMinutes, setRestartWarningMinutes] = useState(5)
  const [delayIfPlayersOnline, setDelayIfPlayersOnline] = useState(false)
  const [maxDelayMinutes, setMaxDelayMinutes] = useState(30)
  
  // Track if auto-discover is pending (moved here for cleanup)
  const autoDiscoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAutoDiscoverIdRef = useRef<string | null>(null)
  
  // Mod Presets
  interface ModPreset {
    id: number
    name: string
    description: string
    workshopIds: string[]
    modIds: string[]
    created_at: string
    updated_at: string
  }
  const [presets, setPresets] = useState<ModPreset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(false)
  const [savePresetOpen, setSavePresetOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetDescription, setPresetDescription] = useState('')
  const [savingPreset, setSavingPreset] = useState(false)
  const [applyingPreset, setApplyingPreset] = useState<number | null>(null)
  
  // Mod conflict detection
  interface ModConflict {
    type: 'duplicate' | 'missing_modid' | 'incompatible' | 'outdated_dependency'
    severity: 'error' | 'warning' | 'info'
    message: string
    modIds?: string[]
    workshopIds?: string[]
  }
  
  // Known incompatible mod pairs (workshop IDs)
  const knownIncompatibleMods: Array<{ mod1: string; mod2: string; reason: string }> = [
    // Add known incompatibilities here
    // { mod1: '123456', mod2: '789012', reason: 'Both modify the same game systems' },
  ]
  
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
    const workshopCount = iniConfig.workshopIds.length
    const modIdCount = iniConfig.modIds.length
    if (workshopCount > 0 && modIdCount === 0) {
      conflicts.push({
        type: 'missing_modid',
        severity: 'warning',
        message: `${workshopCount} workshop items configured but no mod IDs. Run "Sync Mod IDs" after downloading mods.`,
      })
    }
    
    // Check for known incompatible mods
    for (const pair of knownIncompatibleMods) {
      if (iniConfig.workshopIds.includes(pair.mod1) && iniConfig.workshopIds.includes(pair.mod2)) {
        conflicts.push({
          type: 'incompatible',
          severity: 'error',
          message: `Incompatible mods: ${pair.reason}`,
          workshopIds: [pair.mod1, pair.mod2]
        })
      }
    }
    
    return conflicts
  }, [iniConfig])
  
  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current)
      }
      if (autoDiscoverTimeoutRef.current) {
        clearTimeout(autoDiscoverTimeoutRef.current)
      }
    }
  }, [])

  const fetchData = useCallback(async () => {
    try {
      // Use allSettled so one failure doesn't break everything
      const results = await Promise.allSettled([
        modsApi.getTrackedMods(),
        modsApi.getStatus(),
        modsApi.getCurrentConfig()
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
      
      // Log any failures for debugging
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error(`Failed to fetch mods data (index ${index}):`, result.reason)
        }
      })
    } catch (error) {
      console.error('Failed to fetch mods data:', error)
    }
  }, [])

  // Fetch mod presets
  const fetchPresets = useCallback(async () => {
    setPresetsLoading(true)
    try {
      const data = await modsApi.getPresets()
      setPresets(data.presets || [])
    } catch (error) {
      console.error('Failed to fetch presets:', error)
    } finally {
      setPresetsLoading(false)
    }
  }, [])
  
  // Initial data fetch
  useEffect(() => {
    fetchData()
    fetchPresets()
  }, [fetchData, fetchPresets])
  
  const handleSavePreset = async () => {
    if (!presetName.trim()) return
    setSavingPreset(true)
    try {
      await modsApi.createPreset(presetName.trim(), presetDescription.trim())
      toast({
        title: 'Preset Saved',
        description: `Mod preset "${presetName}" has been saved`,
        variant: 'success' as const,
      })
      setSavePresetOpen(false)
      setPresetName('')
      setPresetDescription('')
      fetchPresets()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save preset',
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
        title: 'Preset Applied',
        description: result.message,
        variant: 'success' as const,
      })
      fetchData() // Refresh current config
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to apply preset',
        variant: 'destructive',
      })
    } finally {
      setApplyingPreset(null)
    }
  }
  
  const handleDeletePreset = async (id: number, name: string) => {
    try {
      await modsApi.deletePreset(id)
      toast({
        title: 'Preset Deleted',
        description: `Preset "${name}" has been deleted`,
        variant: 'success' as const,
      })
      fetchPresets()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete preset',
        variant: 'destructive',
      })
    }
  }

  // Filtered mods based on search and filters
  const filteredMods = useMemo(() => {
    let result = [...mods]
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
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
  }, [mods, searchQuery, showUpdatesOnly])

  const handleCheckUpdates = async () => {
    setChecking(true)
    try {
      const result = await modsApi.checkUpdates()
      toast({
        title: 'Updates Checked',
        description: `${result.updatesFound || 0} mod(s) have updates available`,
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to check updates',
        variant: 'destructive',
      })
    } finally {
      setChecking(false)
    }
  }

  // Parse workshop ID from input (URL or ID)
  const parseWorkshopId = (input: string): string | null => {
    const trimmed = input.trim()
    if (!trimmed) return null
    
    // Try to extract from URL patterns
    const urlMatch = trimmed.match(/id=(\d+)/)
    if (urlMatch) return urlMatch[1]
    
    // Try direct numeric ID
    const numericMatch = trimmed.match(/^(\d{6,15})$/)
    if (numericMatch) return numericMatch[1]
    
    return null
  }

  // Auto-discover on paste (debounced)
  const handleModInputChange = useCallback((value: string) => {
    setAdvancedModInput(value)
    
    // Clear any pending auto-discover
    if (autoDiscoverTimeoutRef.current) {
      clearTimeout(autoDiscoverTimeoutRef.current)
      autoDiscoverTimeoutRef.current = null
    }
    
    // Auto-discover if user pastes a valid URL
    if (value.includes('steamcommunity.com') && value.includes('id=')) {
      const workshopId = parseWorkshopId(value)
      
      // Debounce and prevent duplicate triggers
      if (workshopId && workshopId !== lastAutoDiscoverIdRef.current) {
        lastAutoDiscoverIdRef.current = workshopId
        autoDiscoverTimeoutRef.current = setTimeout(() => {
          // Trigger the discovery function
          document.getElementById('discover-mod-btn')?.click()
        }, 200)
      }
    }
  }, [])

  // Discover mod IDs from workshop URL/ID
  const handleDiscoverMod = async () => {
    const workshopId = parseWorkshopId(advancedModInput)
    
    if (!workshopId) {
      toast({
        title: 'Invalid Input',
        description: 'Please enter a valid Workshop URL or numeric ID (e.g., 3616536783)',
        variant: 'destructive',
      })
      return
    }
    
    // Prevent double-triggering
    if (discoveringMod) return
    
    // Check if already configured
    if (iniConfig?.workshopIds?.includes(workshopId)) {
      toast({
        title: 'Already Added',
        description: 'This mod is already in your server configuration',
        variant: 'default',
      })
    }
    
    setDiscoveringMod(true)
    setDiscoveredMod(null)
    setSelectedModIds(new Set())
    
    try {
      const result = await modsApi.discoverModIds(workshopId)
      
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
          title: 'No Mod IDs Found',
          description: result.isDownloaded 
            ? 'Mod is downloaded but no mod.info files found'
            : 'Mod not yet downloaded. Add it anyway and sync after the server downloads it.',
          variant: 'default',
        })
      } else if (alreadyConfigured.length > 0 && alreadyConfigured.length === uniqueModIds.length) {
        toast({
          title: 'Already Configured',
          description: 'All mod IDs from this workshop item are already in your server config',
          variant: 'default',
        })
      } else if (newResult.hasMultipleModIds) {
        toast({
          title: 'Multiple Mod IDs Found',
          description: `Found ${uniqueModIds.length} mod IDs. ${newModIds.length} new, ${alreadyConfigured.length} already configured.`,
        })
      }
    } catch (error) {
      toast({
        title: 'Discovery Failed',
        description: error instanceof Error ? error.message : 'Failed to discover mod IDs. Check the Workshop ID and try again.',
        variant: 'destructive',
      })
    } finally {
      setDiscoveringMod(false)
    }
  }
  
  // Add mod with selected mod IDs
  const handleAddModAdvanced = async () => {
    if (!discoveredMod) return
    
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
          title: 'Mod Added',
          description: result.message + (result.mapFoldersAdded.length > 0 
            ? ` (Maps: ${result.mapFoldersAdded.join(', ')})` 
            : ''),
          variant: 'success' as const,
        })
      } else if (result.workshopAlreadyExisted) {
        toast({
          title: 'Already Configured',
          description: 'This mod is already in your server configuration',
        })
      } else {
        toast({
          title: 'Workshop ID Added',
          description: 'Workshop ID added. Mod IDs will be synced after server downloads the mod.',
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
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to add mod',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
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
    setLoading(true)
    try {
      // Remove from tracking
      await modsApi.untrackMod(workshopId)
      
      // Also remove from server .ini file
      try {
        await modsApi.removeFromIni(workshopId)
      } catch (iniError) {
        console.warn('Could not remove mod from INI:', iniError)
      }
      
      toast({
        title: 'Success',
        description: 'Mod removed from tracking and server config',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to remove mod',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleBulkRemove = async () => {
    if (selectedMods.size === 0) return
    
    setLoading(true)
    const successes: string[] = []
    const failures: string[] = []
    
    try {
      for (const workshopId of selectedMods) {
        try {
          await modsApi.untrackMod(workshopId)
          // Also remove from server .ini file
          try {
            await modsApi.removeFromIni(workshopId)
          } catch (iniError) {
            console.warn('Could not remove mod from INI:', iniError)
          }
          successes.push(workshopId)
        } catch (error) {
          failures.push(workshopId)
          console.error(`Failed to remove mod ${workshopId}:`, error)
        }
      }
      
      if (failures.length > 0) {
        toast({
          title: 'Partial Success',
          description: `Removed ${successes.length} mods, ${failures.length} failed`,
          variant: 'destructive',
        })
      } else {
        toast({
          title: 'Success',
          description: `Removed ${successes.length} mods from tracking and server config`,
        })
      }
      setSelectedMods(new Set())
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to remove mods',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleToggleAutoRestart = async () => {
    setLoading(true)
    try {
      await modsApi.setAutoRestart(!status?.autoRestartEnabled)
      toast({
        title: 'Success',
        description: `Auto-restart ${status?.autoRestartEnabled ? 'disabled' : 'enabled'}`,
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update setting',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleSyncFromServer = async () => {
    setLoading(true)
    try {
      const result = await modsApi.syncFromServer()
      toast({
        title: 'Success',
        description: `Synced ${result.synced || 0} mods from server configuration`,
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to sync mods',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleClearUpdates = async () => {
    setLoading(true)
    try {
      await modsApi.clearUpdates()
      toast({
        title: 'Success',
        description: 'Update flags cleared',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to clear updates',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleImportCollection = async () => {
    if (!collectionUrl) {
      toast({
        title: 'Error',
        description: 'Please enter a collection URL or ID',
        variant: 'destructive',
      })
      return
    }

    setImportingCollection(true)
    try {
      const result = await modsApi.importCollection(collectionUrl)
      setCollectionMods(result.mods.map((m: CollectionMod) => ({
        ...m,
        selected: true,
        modId: m.workshopId,
        mapFolder: m.isMap ? m.name.replace(/\s+/g, '') : undefined
      })))
      
      toast({
        title: 'Collection Loaded',
        description: `Found ${result.mods.length} mods in the collection`,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to import collection',
        variant: 'destructive',
      })
    } finally {
      setImportingCollection(false)
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
        title: 'Error',
        description: 'Please select at least one mod',
        variant: 'destructive',
      })
      return
    }

    setLoading(true)
    try {
      let added = 0
      for (const mod of selectedModsList) {
        try {
          await modsApi.trackMod(mod.workshopId)
          added++
        } catch {
          console.warn(`Failed to add mod ${mod.workshopId}`)
        }
      }

      setModsToInstall(prev => {
        const existing = new Set(prev.map(m => m.workshopId))
        const newMods = selectedModsList.filter(m => !existing.has(m.workshopId))
        return [...prev, ...newMods]
      })

      toast({
        title: 'Success',
        description: `Added ${added} mods for tracking`,
      })
      
      setCollectionDialogOpen(false)
      setCollectionMods([])
      setCollectionUrl('')
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to add mods',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleWriteToIni = async () => {
    if (modsToInstall.length === 0) {
      toast({
        title: 'Error',
        description: 'No mods to configure',
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
        title: 'Configuration Saved',
        description: `${result.modsConfigured} mods configured. Restart server to apply.`,
      })
      
      setModsToInstall([])
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to write configuration',
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
      
      const synced = result.synced || 0
      const missing = result.missingMods?.length || 0
      
      if (synced > 0 || missing > 0) {
        toast({
          title: 'Mod IDs Synced',
          description: `${synced} mod ID(s) added to config.${missing > 0 ? ` ${missing} mod(s) not yet downloaded.` : ''}`,
        })
      } else {
        toast({
          title: 'Already Synced',
          description: 'All downloaded mods are already in the Mods= configuration.',
        })
      }
      
      // Refresh ini config display
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to sync mod IDs',
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

  const handleSaveModOrder = async () => {
    try {
      setSavingModOrder(true)
      await modsApi.saveModOrder(orderedModIds)
      toast({
        title: 'Mod Order Saved',
        description: 'The mod load order has been updated in the server INI.',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save mod order',
        variant: 'destructive',
      })
    } finally {
      setSavingModOrder(false)
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
    window.open(`https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`, '_blank')
  }

  const toggleModSelect = (workshopId: string) => {
    setSelectedMods(prev => {
      const newSet = new Set(prev)
      if (newSet.has(workshopId)) {
        newSet.delete(workshopId)
      } else {
        newSet.add(workshopId)
      }
      return newSet
    })
  }

  const selectAllVisible = () => {
    setSelectedMods(new Set(filteredMods.map(m => m.workshop_id)))
  }

  const deselectAll = () => {
    setSelectedMods(new Set())
  }

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      // Clear any existing timeout
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current)
      }
      copiedTimeoutRef.current = setTimeout(() => setCopiedField(null), 2000)
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to copy to clipboard',
        variant: 'destructive',
      })
    }
  }

  const handleSaveRestartSettings = async () => {
    setLoading(true)
    try {
      await modsApi.setRestartOptions({
        warningMinutes: restartWarningMinutes,
        delayIfPlayersOnline: delayIfPlayersOnline,
        maxDelayMinutes: maxDelayMinutes
      })
      toast({
        title: 'Settings Saved',
        description: 'Restart options have been updated',
      })
      setRestartSettingsOpen(false)
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save settings',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleCancelPendingRestart = async () => {
    setLoading(true)
    try {
      await modsApi.cancelPendingRestart()
      toast({
        title: 'Restart Cancelled',
        description: 'Pending restart has been cancelled',
      })
      fetchData()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to cancel restart',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  // Memoized list of mods with updates available
  const modsWithUpdates = useMemo(() => mods.filter(m => m.update_available), [mods])

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Mod Manager</h1>
            <p className="text-sm text-muted-foreground">Track, update, and configure Steam Workshop mods</p>
          </div>
        </div>

        {/* Quick Stats Bar */}
        <div className="flex items-center gap-4 p-3 bg-muted/50 rounded-lg flex-wrap">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">{status?.totalModsTracked || 0} tracked</span>
          </div>
          <Separator orientation="vertical" className="h-4" />
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">{iniConfig?.totalMods || 0} configured</span>
          </div>
          {modsWithUpdates.length > 0 && (
            <>
              <Separator orientation="vertical" className="h-4" />
              <div className="flex items-center gap-2 text-yellow-500">
                <AlertTriangle className="w-4 h-4" />
                <span className="text-sm font-medium">{modsWithUpdates.length} updates</span>
              </div>
            </>
          )}
          <Separator orientation="vertical" className="h-4" />
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              {status?.lastCheck ? `Checked: ${new Date(status.lastCheck).toLocaleTimeString()}` : 'Never checked'}
            </span>
          </div>
          
          {/* Workshop ACF Status */}
          {!status?.workshopAcfConfigured && (
            <>
              <Separator orientation="vertical" className="h-4" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-2 text-destructive">
                    <AlertTriangle className="w-4 h-4" />
                    <span className="text-xs">ACF Not Found</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Workshop ACF file not found</p>
                  <p className="text-xs text-muted-foreground">Configure server install path in Settings</p>
                </TooltipContent>
              </Tooltip>
            </>
          )}
          
          <div className="flex-1" />
          
          {/* Restart Settings Button */}
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => setRestartSettingsOpen(true)}
            className="h-8"
          >
            <Settings2 className="w-4 h-4 mr-2" />
            Restart Settings
          </Button>
          
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Auto-restart:</span>
            <Switch
              checked={status?.autoRestartEnabled || false}
              onCheckedChange={handleToggleAutoRestart}
              disabled={loading}
            />
          </div>
        </div>

        {/* Pending Restart Alert */}
        {status?.pendingRestart && (
          <div className="p-3 rounded-lg border border-orange-500/50 bg-orange-500/10 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Clock className="w-5 h-5 text-orange-500 animate-pulse" />
              <div>
                <p className="font-medium text-orange-500">Restart Pending</p>
                <p className="text-xs text-muted-foreground">
                  Waiting for players to leave before restarting (max {status.maxDelayMinutes} min)
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleCancelPendingRestart} disabled={loading}>
              Cancel
            </Button>
          </div>
        )}

        <Tabs defaultValue="mods" className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <TabsList>
              <TabsTrigger value="mods">
                <Package className="w-4 h-4 mr-2" />
                Tracked Mods
              </TabsTrigger>
              <TabsTrigger value="config">
                <Settings2 className="w-4 h-4 mr-2" />
                Server Config
              </TabsTrigger>
            </TabsList>

            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={handleSyncFromServer} disabled={loading}>
                <Download className="w-4 h-4 mr-2" />
                Sync from Server
              </Button>
              <Button variant="outline" size="sm" onClick={handleCheckUpdates} disabled={checking}>
                <RefreshCw className={`w-4 h-4 mr-2 ${checking ? 'animate-spin' : ''}`} />
                Check Updates
              </Button>
              
              {/* Import Collection Dialog */}
              <Dialog open={collectionDialogOpen} onOpenChange={setCollectionDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="secondary" size="sm">
                    <Library className="w-4 h-4 mr-2" />
                    Import Collection
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl max-h-[80vh]">
                  <DialogHeader>
                    <DialogTitle>Import Steam Workshop Collection</DialogTitle>
                    <DialogDescription>
                      Import all mods from a Steam Workshop collection
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label>Collection URL or ID</Label>
                      <div className="flex gap-2">
                        <Input
                          value={collectionUrl}
                          onChange={(e) => setCollectionUrl(e.target.value)}
                          placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=..."
                        />
                        <Button onClick={handleImportCollection} disabled={importingCollection}>
                          {importingCollection ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Download className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                    
                    {collectionMods.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label>Found {collectionMods.length} mods</Label>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setCollectionMods(prev => prev.map(m => ({ ...m, selected: true })))}
                            >
                              Select All
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setCollectionMods(prev => prev.map(m => ({ ...m, selected: false })))}
                            >
                              Deselect All
                            </Button>
                          </div>
                        </div>
                        <ScrollArea className="h-[300px] border rounded-md p-2">
                          <div className="space-y-2">
                            {collectionMods.map((mod) => (
                              <div 
                                key={mod.workshopId} 
                                className={`p-3 rounded-md border flex items-start gap-3 ${mod.selected ? 'bg-accent/50' : ''}`}
                              >
                                <Checkbox
                                  checked={mod.selected}
                                  onCheckedChange={() => toggleModSelection(mod.workshopId)}
                                />
                                <div className="flex-1 space-y-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-sm">{mod.name}</span>
                                    {mod.isMap && (
                                      <Badge variant="secondary" className="text-xs">
                                        <Map className="w-3 h-3 mr-1" />
                                        Map
                                      </Badge>
                                    )}
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    ID: {mod.workshopId}
                                  </p>
                                  {mod.selected && (
                                    <div className="grid grid-cols-2 gap-2 mt-2">
                                      <div>
                                        <Label className="text-xs">Mod ID</Label>
                                        <Input
                                          value={mod.modId || ''}
                                          onChange={(e) => updateModId(mod.workshopId, e.target.value)}
                                          placeholder="From info.txt"
                                          className="h-7 text-xs"
                                        />
                                      </div>
                                      {mod.isMap && (
                                        <div>
                                          <Label className="text-xs">Map Folder</Label>
                                          <Input
                                            value={mod.mapFolder || ''}
                                            onChange={(e) => updateMapFolder(mod.workshopId, e.target.value)}
                                            placeholder="MapFolderName"
                                            className="h-7 text-xs"
                                          />
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  onClick={() => openWorkshopPage(mod.workshopId)}
                                >
                                  <ExternalLink className="w-3 h-3" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      </div>
                    )}
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCollectionDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button 
                      onClick={handleAddCollectionMods} 
                      disabled={loading || collectionMods.filter(m => m.selected).length === 0}
                    >
                      Add {collectionMods.filter(m => m.selected).length} Mods
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
                }
              }}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="w-4 h-4 mr-2" />
                    Add Mod
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Add Workshop Mod</DialogTitle>
                    <DialogDescription>
                      Paste a Steam Workshop URL or ID. Mod IDs will be auto-discovered.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    {/* Input section */}
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <Input
                          value={advancedModInput}
                          onChange={(e) => handleModInputChange(e.target.value)}
                          placeholder="Paste Workshop URL or enter ID..."
                          onKeyDown={(e) => e.key === 'Enter' && !discoveringMod && handleDiscoverMod()}
                          className="font-mono text-sm"
                        />
                        <Button 
                          id="discover-mod-btn"
                          onClick={handleDiscoverMod} 
                          disabled={discoveringMod || !advancedModInput.trim()}
                          variant="secondary"
                          className="shrink-0"
                        >
                          {discoveringMod ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <>
                              <Search className="w-4 h-4 mr-1" />
                              Discover
                            </>
                          )}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Example: https://steamcommunity.com/sharedfiles/filedetails/?id=3616536783
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
                                onClick={() => window.open(`https://steamcommunity.com/sharedfiles/filedetails/?id=${discoveredMod.workshopId}`, '_blank')}
                                className="text-xs text-primary hover:underline flex items-center gap-0.5"
                              >
                                <ExternalLink className="w-3 h-3" />
                                View
                              </button>
                            </div>
                          </div>
                          <div className="flex gap-1 shrink-0">
                            {discoveredMod.isMap && (
                              <Badge variant="secondary" className="text-xs h-5">
                                <Map className="w-3 h-3 mr-1" />
                                Map
                              </Badge>
                            )}
                            {discoveredMod.isDownloaded ? (
                              <Badge variant="outline" className="text-xs text-green-600 h-5">
                                <CheckCircle className="w-3 h-3 mr-1" />
                                Downloaded
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs text-orange-500 h-5">
                                <Download className="w-3 h-3 mr-1" />
                                Not Downloaded
                              </Badge>
                            )}
                          </div>
                        </div>
                        
                        {/* Already added warning */}
                        {discoveredMod.isAlreadyAdded && (
                          <div className="flex items-center gap-2 p-2 bg-blue-500/10 border border-blue-500/30 rounded text-xs">
                            <Info className="w-4 h-4 text-blue-500 shrink-0" />
                            <span>Workshop ID is already in your server config</span>
                          </div>
                        )}
                        
                        {/* Mod IDs selection */}
                        {discoveredMod.modIds.length > 0 ? (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <Label className="text-xs font-medium">
                                {discoveredMod.hasMultipleModIds 
                                  ? `Mod IDs (${selectedModIds.size} of ${discoveredMod.modIds.length} selected)`
                                  : 'Mod ID'}
                              </Label>
                              {discoveredMod.hasMultipleModIds && (
                                <div className="flex gap-1">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 text-xs px-2"
                                    onClick={() => {
                                      // Select only new (not already configured) mod IDs
                                      const newIds = discoveredMod.modIds.filter(
                                        id => !discoveredMod.alreadyConfigured?.includes(id)
                                      )
                                      setSelectedModIds(new Set(newIds))
                                    }}
                                  >
                                    Select New
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 text-xs px-2"
                                    onClick={() => {
                                      if (selectedModIds.size === discoveredMod.modIds.length) {
                                        setSelectedModIds(new Set())
                                      } else {
                                        setSelectedModIds(new Set(discoveredMod.modIds))
                                      }
                                    }}
                                  >
                                    {selectedModIds.size === discoveredMod.modIds.length ? 'None' : 'All'}
                                  </Button>
                                </div>
                              )}
                            </div>
                            <div className="space-y-1 max-h-40 overflow-y-auto rounded border bg-background p-1">
                              {discoveredMod.modIds.map((modId) => {
                                const isConfigured = discoveredMod.alreadyConfigured?.includes(modId)
                                return (
                                  <div 
                                    key={modId}
                                    className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${
                                      selectedModIds.has(modId) 
                                        ? 'bg-primary/10 border border-primary' 
                                        : isConfigured
                                          ? 'bg-muted/50 border border-transparent'
                                          : 'hover:bg-muted/50 border border-transparent'
                                    }`}
                                    onClick={() => toggleModIdSelection(modId)}
                                  >
                                    <Checkbox 
                                      checked={selectedModIds.has(modId)} 
                                      onCheckedChange={() => toggleModIdSelection(modId)}
                                    />
                                    <code className="text-xs font-mono flex-1 truncate" title={modId}>
                                      {modId}
                                    </code>
                                    {isConfigured && (
                                      <Badge variant="outline" className="text-xs h-5 shrink-0 text-muted-foreground">
                                        Exists
                                      </Badge>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 p-2.5 bg-yellow-500/10 border border-yellow-500/30 rounded text-xs">
                            <AlertTriangle className="w-4 h-4 text-yellow-600 shrink-0" />
                            <div>
                              <p className="font-medium text-yellow-700 dark:text-yellow-500">
                                {discoveredMod.isDownloaded 
                                  ? 'No mod.info files found'
                                  : 'Mod not yet downloaded'}
                              </p>
                              <p className="text-muted-foreground mt-0.5">
                                {discoveredMod.isDownloaded 
                                  ? 'This mod may use an unconventional structure'
                                  : 'Add the Workshop ID and sync after server downloads it'}
                              </p>
                            </div>
                          </div>
                        )}
                        
                        {/* Map folders info */}
                        {discoveredMod.mapFolders.length > 0 && (
                          <div className="flex items-start gap-2 text-xs">
                            <Map className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                            <div>
                              <span className="font-medium">Map folders will be added:</span>
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
                      className="sm:order-1"
                    >
                      Cancel
                    </Button>
                    <Button 
                      onClick={handleAddModAdvanced} 
                      disabled={loading || !discoveredMod || discoveringMod}
                      className="sm:order-2"
                    >
                      {loading ? (
                        <>
                          <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                          Adding...
                        </>
                      ) : discoveredMod?.modIds.length ? (
                        selectedModIds.size > 0 
                          ? `Add ${selectedModIds.size} Mod ID${selectedModIds.size !== 1 ? 's' : ''}`
                          : 'Add Workshop ID Only'
                      ) : discoveredMod ? (
                        'Add Workshop ID'
                      ) : (
                        'Discover First'
                      )}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              
              {/* Restart Settings Dialog */}
              <Dialog open={restartSettingsOpen} onOpenChange={setRestartSettingsOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Auto-Restart Settings</DialogTitle>
                    <DialogDescription>
                      Configure how the server restarts when mod updates are detected
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label>Warning Time (minutes)</Label>
                      <Input
                        type="number"
                        min="0"
                        max="30"
                        value={restartWarningMinutes}
                        onChange={(e) => setRestartWarningMinutes(parseInt(e.target.value) || 0)}
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        How long to wait before restarting after detecting updates
                      </p>
                    </div>
                    
                    <div className="flex items-center justify-between p-3 rounded-lg border">
                      <div className="space-y-1">
                        <Label>Delay if Players Online</Label>
                        <p className="text-xs text-muted-foreground">
                          Wait for all players to leave before restarting
                        </p>
                      </div>
                      <Switch
                        checked={delayIfPlayersOnline}
                        onCheckedChange={setDelayIfPlayersOnline}
                      />
                    </div>
                    
                    {delayIfPlayersOnline && (
                      <div>
                        <Label>Maximum Delay (minutes)</Label>
                        <Input
                          type="number"
                          min="5"
                          max="120"
                          value={maxDelayMinutes}
                          onChange={(e) => setMaxDelayMinutes(parseInt(e.target.value) || 30)}
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          Force restart after this time even if players are online
                        </p>
                      </div>
                    )}
                    
                    <div className="p-3 rounded-lg bg-muted/50 border">
                      <p className="text-sm font-medium mb-2">Current Settings</p>
                      <div className="text-xs text-muted-foreground space-y-1">
                        <p>• Warning time: {restartWarningMinutes} minutes</p>
                        <p>• Delay for players: {delayIfPlayersOnline ? 'Yes' : 'No'}</p>
                        {delayIfPlayersOnline && <p>• Max delay: {maxDelayMinutes} minutes</p>}
                      </div>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setRestartSettingsOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleSaveRestartSettings} disabled={loading}>
                      {loading ? 'Saving...' : 'Save Settings'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {/* Tracked Mods Tab */}
          <TabsContent value="mods" className="space-y-4">
            {/* Updates Alert */}
            {modsWithUpdates.length > 0 && (
              <div className="p-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 text-yellow-500" />
                  <div>
                    <p className="font-medium text-yellow-500">
                      {modsWithUpdates.length} mod{modsWithUpdates.length > 1 ? 's have' : ' has'} updates available
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Restart the server to apply updates
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={handleClearUpdates} disabled={loading}>
                  Clear Flags
                </Button>
              </div>
            )}

            {/* Search and Filters */}
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search mods..."
                  className="pl-9"
                />
              </div>
              
              <Button
                variant={showUpdatesOnly ? "secondary" : "outline"}
                size="sm"
                onClick={() => setShowUpdatesOnly(!showUpdatesOnly)}
              >
                <Filter className="w-4 h-4 mr-2" />
                Updates Only
              </Button>

              {selectedMods.size > 0 && (
                <div className="flex items-center gap-2 ml-auto">
                  <span className="text-sm text-muted-foreground">
                    {selectedMods.size} selected
                  </span>
                  <Button variant="outline" size="sm" onClick={deselectAll}>
                    Deselect
                  </Button>
                  <Button variant="destructive" size="sm" onClick={handleBulkRemove} disabled={loading}>
                    <Trash2 className="w-4 h-4 mr-2" />
                    Remove
                  </Button>
                </div>
              )}

              {selectedMods.size === 0 && filteredMods.length > 0 && (
                <Button variant="ghost" size="sm" onClick={selectAllVisible} className="ml-auto">
                  Select All ({filteredMods.length})
                </Button>
              )}
            </div>

            {/* Mods List */}
            <Card>
              <CardContent className="p-0">
                <ScrollArea className="h-[500px]">
                  {filteredMods.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Package className="w-12 h-12 text-muted-foreground mb-4" />
                      <p className="text-muted-foreground">
                        {searchQuery ? 'No mods match your search' : 'No mods tracked'}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Add mods manually or sync from server configuration
                      </p>
                    </div>
                  ) : (
                    <div className="divide-y">
                      {filteredMods.map((mod) => (
                        <div
                          key={mod.id}
                          className={`flex items-center gap-3 p-3 hover:bg-accent/50 transition-colors ${
                            selectedMods.has(mod.workshop_id) ? 'bg-accent/30' : ''
                          }`}
                        >
                          <Checkbox
                            checked={selectedMods.has(mod.workshop_id)}
                            onCheckedChange={() => toggleModSelect(mod.workshop_id)}
                          />
                          
                          {mod.update_available ? (
                            <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
                          ) : (
                            <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                          )}
                          
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">
                                {mod.name || `Mod ${mod.workshop_id}`}
                              </span>
                              {mod.update_available ? (
                                <Badge variant="outline" className="text-yellow-500 border-yellow-500 text-xs">
                                  Update
                                </Badge>
                              ) : null}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              ID: {mod.workshop_id} • {mod.last_checked 
                                ? `Checked ${new Date(mod.last_checked).toLocaleDateString()}`
                                : 'Never checked'
                              }
                            </p>
                          </div>
                          
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => openWorkshopPage(mod.workshop_id)}
                              >
                                <ExternalLink className="w-4 h-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Open Workshop Page</TooltipContent>
                          </Tooltip>
                          
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:text-destructive"
                                onClick={() => handleRemoveMod(mod.workshop_id)}
                                disabled={loading}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Remove from tracking</TooltipContent>
                          </Tooltip>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Server Config Tab */}
          <TabsContent value="config" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <FileText className="w-5 h-5" />
                  Server INI Configuration
                </CardTitle>
                <CardDescription>
                  Current mod settings in your server's INI file
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {iniConfig?.configured ? (
                  <>
                    {/* Summary Stats */}
                    <div className="grid grid-cols-3 gap-4">
                      <div className="text-center p-3 rounded-lg bg-muted/50">
                        <div className="text-2xl font-bold">{iniConfig.totalMods}</div>
                        <div className="text-xs text-muted-foreground">Mods</div>
                      </div>
                      <div className="text-center p-3 rounded-lg bg-muted/50">
                        <div className="text-2xl font-bold">{iniConfig.workshopIds.length}</div>
                        <div className="text-xs text-muted-foreground">Workshop Items</div>
                      </div>
                      <div className="text-center p-3 rounded-lg bg-muted/50">
                        <div className="text-2xl font-bold">{iniConfig.maps.length}</div>
                        <div className="text-xs text-muted-foreground">Maps</div>
                      </div>
                    </div>
                    
                    {/* Conflict Warnings */}
                    {detectedConflicts.length > 0 && (
                      <div className="space-y-2">
                        {detectedConflicts.map((conflict, idx) => (
                          <div 
                            key={idx} 
                            className={`flex items-start gap-2 p-3 rounded-lg border ${
                              conflict.severity === 'error' ? 'bg-red-500/10 border-red-500/30' :
                              conflict.severity === 'warning' ? 'bg-yellow-500/10 border-yellow-500/30' :
                              'bg-blue-500/10 border-blue-500/30'
                            }`}
                          >
                            <AlertTriangle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                              conflict.severity === 'error' ? 'text-red-500' :
                              conflict.severity === 'warning' ? 'text-yellow-500' :
                              'text-blue-500'
                            }`} />
                            <div className="text-sm">
                              <span className={`font-medium ${
                                conflict.severity === 'error' ? 'text-red-600' :
                                conflict.severity === 'warning' ? 'text-yellow-600' :
                                'text-blue-600'
                              }`}>
                                {conflict.type === 'duplicate' && 'Duplicate Mods'}
                                {conflict.type === 'missing_modid' && 'Missing Mod IDs'}
                                {conflict.type === 'incompatible' && 'Incompatible Mods'}
                                {conflict.type === 'outdated_dependency' && 'Outdated Dependency'}
                              </span>
                              <span className="text-muted-foreground">: {conflict.message}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Sync Mod IDs Button */}
                    <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border">
                      <div>
                        <p className="text-sm font-medium">Sync Mod IDs from Downloads</p>
                        <p className="text-xs text-muted-foreground">
                          Reads mod.info from downloaded mods and adds their IDs to Mods= in the INI
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
                        Sync Mod IDs
                      </Button>
                    </div>

                    {/* Maps List */}
                    <div>
                      <button
                        onClick={() => setShowMapsExpanded(!showMapsExpanded)}
                        className="flex items-center gap-2 text-sm font-medium mb-2 hover:text-primary transition-colors"
                      >
                        {showMapsExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        <Map className="w-4 h-4" />
                        Maps ({iniConfig.maps.length})
                      </button>
                      {showMapsExpanded && (
                        <div className="flex flex-wrap gap-1 ml-6">
                          {iniConfig.maps.map((map, i) => (
                            <Badge key={i} variant="secondary" className="text-xs">
                              {map}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Mod Load Order */}
                    <div>
                      <button
                        onClick={() => setShowModOrderEditor(!showModOrderEditor)}
                        className="flex items-center gap-2 text-sm font-medium mb-2 hover:text-primary transition-colors"
                      >
                        {showModOrderEditor ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        <Layers className="w-4 h-4" />
                        Mod Load Order ({orderedModIds.length})
                        {hasModOrderChanged && (
                          <Badge variant="outline" className="text-xs ml-2 bg-yellow-500/20 text-yellow-600 border-yellow-500/30">
                            Modified
                          </Badge>
                        )}
                      </button>
                      {showModOrderEditor && (
                        <div className="space-y-2 ml-6">
                          <p className="text-xs text-muted-foreground mb-2">
                            Drag and drop to reorder mods. Mods higher in the list load first.
                          </p>
                          <ScrollArea className="h-[300px] border rounded-lg p-2">
                            <div className="space-y-1">
                              {orderedModIds.map((modId, index) => (
                                <div
                                  key={modId}
                                  draggable
                                  onDragStart={() => handleDragStart(index)}
                                  onDragOver={(e) => handleDragOver(e, index)}
                                  onDragEnd={handleDragEnd}
                                  className={`flex items-center gap-2 p-2 rounded border bg-background hover:bg-muted/50 cursor-move transition-colors ${
                                    draggedModIndex === index ? 'opacity-50 border-primary' : ''
                                  }`}
                                >
                                  <GripVertical className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                  <span className="text-xs text-muted-foreground w-6">{index + 1}.</span>
                                  <span className="text-sm font-mono flex-1 truncate">{modId}</span>
                                  <div className="flex gap-1">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      onClick={() => moveModUp(index)}
                                      disabled={index === 0}
                                    >
                                      <ChevronRight className="w-3 h-3 rotate-[-90deg]" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      onClick={() => moveModDown(index)}
                                      disabled={index === orderedModIds.length - 1}
                                    >
                                      <ChevronRight className="w-3 h-3 rotate-90" />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                          {hasModOrderChanged && (
                            <div className="flex justify-end gap-2 pt-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setOrderedModIds(iniConfig.modIds)}
                              >
                                Reset
                              </Button>
                              <Button
                                size="sm"
                                onClick={handleSaveModOrder}
                                disabled={savingModOrder}
                              >
                                {savingModOrder ? (
                                  <>
                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                    Saving...
                                  </>
                                ) : (
                                  <>
                                    <Save className="w-4 h-4 mr-2" />
                                    Save Order
                                  </>
                                )}
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Copy Buttons */}
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyToClipboard(iniConfig.modIds.join(';'), 'mods')}
                      >
                        {copiedField === 'mods' ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
                        Copy Mods=
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyToClipboard(iniConfig.workshopIds.join(';'), 'workshop')}
                      >
                        {copiedField === 'workshop' ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
                        Copy WorkshopItems=
                      </Button>
                    </div>

                    {/* Pending Mods to Install */}
                    {modsToInstall.length > 0 && (
                      <div className="p-3 rounded-lg border bg-muted/50 space-y-3">
                        <div className="flex items-center justify-between">
                          <Label className="flex items-center gap-2">
                            <Plus className="w-4 h-4" />
                            {modsToInstall.length} mods pending configuration
                          </Label>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setModsToInstall([])}
                          >
                            Clear All
                          </Button>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {modsToInstall.map(mod => (
                            <Badge key={mod.workshopId} variant="outline" className="text-xs">
                              {mod.name}
                              {mod.isMap && <Map className="w-3 h-3 ml-1" />}
                              <button
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
                          Write to Server INI
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-center py-8">
                    <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">{iniConfig?.error || 'Server configuration not found'}</p>
                    <p className="text-sm text-muted-foreground">Start the server once to generate the config file</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Mod Presets */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <FolderOpen className="w-5 h-5" />
                      Mod Presets
                    </CardTitle>
                    <CardDescription>
                      Save and load different mod configurations
                    </CardDescription>
                  </div>
                  <Dialog open={savePresetOpen} onOpenChange={setSavePresetOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm" disabled={!iniConfig?.configured}>
                        <Save className="w-4 h-4 mr-2" />
                        Save Current
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Save Mod Preset</DialogTitle>
                        <DialogDescription>
                          Save the current mod configuration as a preset for easy switching later.
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="presetName">Preset Name</Label>
                          <Input
                            id="presetName"
                            value={presetName}
                            onChange={(e) => setPresetName(e.target.value)}
                            placeholder="e.g., Vanilla+ Light, Hardcore, RP Server"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="presetDesc">Description (optional)</Label>
                          <Input
                            id="presetDesc"
                            value={presetDescription}
                            onChange={(e) => setPresetDescription(e.target.value)}
                            placeholder="Brief description of this preset..."
                          />
                        </div>
                        {iniConfig?.configured && (
                          <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded">
                            This will save {iniConfig.workshopIds.length} workshop items and {iniConfig.modIds.length} mod IDs.
                          </div>
                        )}
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setSavePresetOpen(false)}>
                          Cancel
                        </Button>
                        <Button onClick={handleSavePreset} disabled={savingPreset || !presetName.trim()}>
                          {savingPreset && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                          Save Preset
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardHeader>
              <CardContent>
                {presetsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                  </div>
                ) : presets.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p>No presets saved yet</p>
                    <p className="text-sm">Save your current mod configuration to create a preset</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {presets.map((preset) => (
                      <div
                        key={preset.id}
                        className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium">{preset.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {preset.workshopIds.length} mods • {preset.description || 'No description'}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Saved {new Date(preset.created_at).toLocaleDateString()}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleApplyPreset(preset.id, preset.name)}
                            disabled={applyingPreset === preset.id}
                          >
                            {applyingPreset === preset.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Download className="w-4 h-4" />
                            )}
                            <span className="ml-1.5">Load</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDeletePreset(preset.id, preset.name)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Help Card */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Info className="w-5 h-5" />
                  How Mod Management Works
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <div className="flex items-start gap-3">
                  <Download className="w-4 h-4 mt-0.5 text-primary" />
                  <div>
                    <p className="font-medium text-foreground">Sync from Server</p>
                    <p>Import all mods currently configured in your server's INI file</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <RefreshCw className="w-4 h-4 mt-0.5 text-primary" />
                  <div>
                    <p className="font-medium text-foreground">Update Detection</p>
                    <p>Periodically checks Steam Workshop for mod updates</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Power className="w-4 h-4 mt-0.5 text-primary" />
                  <div>
                    <p className="font-medium text-foreground">Auto-Restart</p>
                    <p>When enabled, server restarts automatically when updates are detected</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  )
}
