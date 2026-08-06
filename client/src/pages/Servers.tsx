import { useTranslation } from 'react-i18next';
import { useState, useEffect, useContext, useRef, useCallback } from 'react'
import { 
  Server, 
  Plus, 
  Trash2, 
  Edit2, 
  Check,
  Power,
  MoreVertical,
  Star,
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
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'


import { reportClientError, reportClientWarning } from '@/lib/client-errors'
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
import { serversApi, serversDetectApi, ServerInstance, configApi, serverApi, updateApi, UpdateStatus } from '@/lib/api'
import { SocketContext } from '@/contexts/SocketContext'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'

interface DetectedServerConfig {
  dataPath: string
  serverConfigPath: string
  serverName: string
  iniFile: string
  rconPort: number
  rconPassword: string
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
  rconPassword: string
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

export default function Servers() {
  const { t } = useTranslation('servers');
  
  
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [serverStatuses, setServerStatuses] = useState<Record<string, { running: boolean; pid: string | null }>>({})
  const [loading, setLoading] = useState(true)
  const [editingServer, setEditingServer] = useState<ServerInstance | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [deleteServer, setDeleteServer] = useState<ServerInstance | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteProgress, setDeleteProgress] = useState(0)
  const deleteProgressRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [activating, setActivating] = useState<string | number | null>(null)
  
  // Add server dialog
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newServer, setNewServer] = useState<NewServerForm>(defaultNewServer)
  const [addingServer, setAddingServer] = useState(false)
  const [addMode, setAddMode] = useState<'local' | 'remote'>('local')
  
  // Detection state
  const [detecting, setDetecting] = useState(false)
  const [detectResult, setDetectResult] = useState<DetectResult | null>(null)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [selectedServerConfig, setSelectedServerConfig] = useState<string>('')
  
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
  const [clearingInstall, setClearingInstall] = useState(false)
  const [confirmClearInstall, setConfirmClearInstall] = useState(false)
  const [steamcmdPath, setSteamcmdPath] = useState('')
  const [updateInfo, setUpdateInfo] = useState<UpdateStatus | null>(null)
  const [gameVersion, setGameVersion] = useState<string | null>(null)
  const [availableBranches, setAvailableBranches] = useState<Array<{name: string, description: string, buildId?: string | null, timeUpdated?: string | null}>>([
    { name: 'public', description: '' },
    { name: 'unstable', description: '' }
  ])
  const [loadingBranches, setLoadingBranches] = useState(false)
  
  const { toast } = useToast()
  const socket = useContext(SocketContext)
  const navigate = useNavigate()

  const getBranchLabel = (name: string) => name === 'public' ? t('steam.publicStable') : name
  const getBranchDescription = (branch: { name: string; description: string }) => {
    if (branch.name === 'public') return t('branches.publicDescription')
    if (branch.name === 'unstable') return t('branches.unstableDescription')
    if (branch.name === 'iwbums') return t('branches.iwbumsDescription')
    return branch.description
  }


  // Fetch servers
  const fetchServers = useCallback(async () => {
    try {
      const data = await serversApi.getAll()
      setServers(data.servers || [])
    } catch (error) {
      reportClientError('Failed to fetch servers.', error)
      toast({ title: t('toasts.error'), description: t('toasts.failedToLoadServers'), variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  // Per-server running status — scans host processes once and attributes
  // matches to each configured server's install path. Refreshes on a slow
  // 15s cadence (process detection is heavyweight) and on socket events.
  // Skipped while the tab is hidden so background tabs don't keep firing
  // a heavyweight host-process scan.
  const fetchServerStatuses = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    try {
      const data = await serversApi.getStatus()
      const next: Record<string, { running: boolean; pid: string | null }> = {}
      for (const s of data.servers || []) {
        next[String(s.id)] = { running: !!s.running, pid: s.pid }
      }
      setServerStatuses(next)
    } catch (error) {
      // Non-fatal: status is supplemental info, not the source of truth.
      reportClientWarning('Failed to fetch per-server status.', error)
    }
  }, [])

  // Load steamcmd path and servers on mount
  useEffect(() => {
    fetchServers()
    fetchServerStatuses()
    const statusInterval = setInterval(fetchServerStatuses, 15000)
    // Load steamcmd path from settings
    configApi.getAppSettings().then(data => {
      if (data.settings?.steamcmdPath) {
        setSteamcmdPath(data.settings.steamcmdPath)
      }
    }).catch(e => reportClientWarning('Failed to load settings.', e))
    // Load update status
    updateApi.getStatus().then(status => {
      if (status.updateAvailable?.updateAvailable) {
        setUpdateInfo(status.updateAvailable)
      }
      if (status.gameVersion) {
        setGameVersion(status.gameVersion)
      }
    }).catch(e => reportClientWarning('Failed to load update status.', e))
    return () => clearInterval(statusInterval)
  }, [fetchServers, fetchServerStatuses])

  // Listen for update status changes (clears banner after successful update)
  useEffect(() => {
    if (!socket) return

    const handleUpdateAvailable = (data: UpdateStatus) => {
      setUpdateInfo(data.updateAvailable ? data : null)
    }
    const handleUpdateCheck = (data: UpdateStatus) => {
      setUpdateInfo(data.updateAvailable ? data : null)
    }

    socket.on('server:updateAvailable', handleUpdateAvailable)
    socket.on('server:updateCheck', handleUpdateCheck)
    return () => {
      socket.off('server:updateAvailable', handleUpdateAvailable)
      socket.off('server:updateCheck', handleUpdateCheck)
    }
  }, [socket])

  // Fetch available Steam branches when steam operation dialog opens
  useEffect(() => {
    if (!steamOperation) return
    
    const fetchBranches = async () => {
      setLoadingBranches(true)
      try {
        const detection = await serverApi.detectSteamCmd()
        const resolvedSteamcmdPath = detection.found && detection.path ? detection.path : steamcmdPath
        if (resolvedSteamcmdPath && resolvedSteamcmdPath !== steamcmdPath) {
          setSteamcmdPath(resolvedSteamcmdPath)
        }
        const data = await serverApi.getBranches(resolvedSteamcmdPath)
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
                  ? t('branches.unstableDescription')
                  : name === 'iwbums'
                    ? t('branches.iwbumsDescription')
                    : t('branches.customDescription')
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
        setLoadingBranches(false)
      }
    }
    
    fetchBranches()
  }, [steamOperation, steamcmdPath, updateInfo?.installed?.branch, t])

  // Listen for server changes
  useEffect(() => {
    if (!socket) return
    
    const handleActiveServerChanged = () => {
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
    
    const handleSteamStart = (data: { type: string; message: string }) => {
      setSteamRunning(true)
      setSteamLogs([data.message])
    }
    
    const handleSteamLog = (data: { type: string; text: string }) => {
      setSteamLogs(prev => [...prev.slice(-200), data.text]) // Keep last 200 lines
    }
    
    const handleSteamComplete = (data: { success: boolean; message: string }) => {
      setSteamRunning(false)
      setSteamCompleted(data.success ? 'success' : 'error')
      setSteamLogs(prev => [...prev, '', data.success ? '✓ ' + data.message : '✗ ' + data.message])
      toast({
        title: data.success ? t('toasts.success') : t('toasts.failed'),
        description: data.message,
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
  }, [socket, t, toast])

  // Detect server settings from data path
  const handleDetectServer = async () => {
    if (!newServer.zomboidDataPath.trim()) {
      toast({ title: t('toasts.error'), description: t('validation.enterServerDataPath'), variant: 'destructive' })
      return
    }
    
    setDetecting(true)
    setDetectError(null)
    setDetectResult(null)
    setSelectedServerConfig('')
    
    try {
      const data = await serversDetectApi.detect({
        dataPath: newServer.zomboidDataPath,
        installPath: newServer.installPath || undefined
      }) as unknown as DetectResult & { error?: string }
      
      if (!data || data.error) {
        setDetectError(data?.error || t('validation.detectionFailed'))
        return
      }
      
      setDetectResult(data)
      
      // Auto-select first server if only one
      if (data.detectedServers.length === 1) {
        handleSelectServerConfig(data.detectedServers[0], data)
      } else if (data.detectedServers.length > 1) {
        toast({ 
          title: t('toasts.multipleServersFound'),
          description: t('toasts.selectServerConfiguration')
        })
      }
      
      // Update useNoSteam based on detection
      if (data.hasNoSteam) {
        setNewServer(prev => ({ ...prev, useNoSteam: true }))
      }
      
    } catch (error) {
      setDetectError(error instanceof Error ? error.message : t('validation.detectionFailed'))
    } finally {
      setDetecting(false)
    }
  }
  
  // Auto-scan a folder to find all PZ server paths
  const handleAutoScan = async () => {
    if (!autoScanPath.trim()) {
      toast({ title: t('toasts.error'), description: t('validation.enterScanPath'), variant: 'destructive' })
      return
    }
    
    setAutoScanning(true)
    setAutoScanResult(null)
    
    try {
      const data = await serversDetectApi.autoScan({ scanPath: autoScanPath, maxDepth: 4 }) as unknown as AutoScanResult & { error?: string }
      
      if (!data || data.error) {
        toast({ title: t('toasts.scanFailed'), description: data.error || t('toasts.unknownError'), variant: 'destructive' })
        return
      }
      
      setAutoScanResult(data)
      
      if (data.detectedConfigs.length === 0) {
        toast({ 
          title: t('toasts.noServersFound'),
          description: t('toasts.noServersFoundDescription')
        })
      } else {
        toast({ 
          title: t('toasts.serversFound'),
          description: t('toasts.serverConfigurationsFound', { count: data.detectedConfigs.length })
        })
      }
      
    } catch (error) {
      toast({ 
        title: t('toasts.scanFailed'),
        description: error instanceof Error ? error.message : t('toasts.autoScanFailed'),
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
      rconPassword: config.rconPassword,
      serverPort: config.serverPort,
    })
    setSelectedServerConfig(config.serverName)
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
        rconPassword: config.rconPassword,
        serverPort: config.serverPort,
        publicName: config.publicName,
        hasRcon: config.hasRcon
      }]
    })
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
      rconPassword: config.rconPassword,
      serverPort: config.serverPort
    }))
    
    if (!config.hasRcon) {
      toast({
        title: t('toasts.rconNotConfigured'),
        description: t('toasts.rconNotConfiguredDescription'),
        variant: 'destructive'
      })
    }
  }

  const handleActivateServer = useCallback(async (server: ServerInstance) => {
    if (server.isActive) return
    
    setActivating(server.id)
    try {
      await serversApi.activate(server.id)
      toast({ 
        title: t('toasts.serverActivated'),
        description: t('toasts.nowManaging', { name: server.name })
      })
      fetchServers()
    } catch (error) {
      toast({ 
        title: t('toasts.error'),
        description: error instanceof Error ? error.message : t('toasts.failedToActivate'),
        variant: 'destructive'
      })
    } finally {
      setActivating(null)
    }
  }, [fetchServers, t, toast])

  // Inline Start/Stop on server cards. The Node side `serverApi.start/stop`
  // operate on the currently-active instance only, so for inactive servers
  // we activate first, wait for the switch to land, then issue start. This
  // mirrors what users would otherwise do manually from the dropdown.
  const [serverActionPending, setServerActionPending] = useState<string | null>(null)
  const handleInlineStart = useCallback(async (server: ServerInstance) => {
    setServerActionPending(`start-${server.id}`)
    try {
      if (!server.isActive) {
        await serversApi.activate(server.id)
      }
      await serverApi.start()
      toast({ title: t('toasts.serverStarting'), description: server.name || server.serverName })
      fetchServers()
      fetchServerStatuses()
    } catch (error) {
      toast({
        title: t('toasts.failedToStart'),
        description: error instanceof Error ? error.message : t('toasts.unknownError'),
        variant: 'destructive',
      })
    } finally {
      setServerActionPending(null)
    }
  }, [fetchServerStatuses, fetchServers, t, toast])

  const handleInlineStop = useCallback(async (server: ServerInstance) => {
    setServerActionPending(`stop-${server.id}`)
    try {
      if (!server.isActive) {
        await serversApi.activate(server.id)
      }
      await serverApi.stop()
      toast({ title: t('toasts.serverStopping'), description: server.name || server.serverName })
      fetchServers()
      fetchServerStatuses()
    } catch (error) {
      toast({
        title: t('toasts.failedToStop'),
        description: error instanceof Error ? error.message : t('toasts.unknownError'),
        variant: 'destructive',
      })
    } finally {
      setServerActionPending(null)
    }
  }, [fetchServerStatuses, fetchServers, t, toast])

  const handleDeleteServer = async () => {
    if (!deleteServer) return
    
    setDeleting(true)
    setDeleteProgress(0)

    // Animate progress: fast to ~70%, then slow crawl to ~90%
    let prog = 0
    deleteProgressRef.current = setInterval(() => {
      prog += prog < 70 ? 8 : 1
      if (prog > 92) prog = 92
      setDeleteProgress(prog)
    }, 200)

    try {
      // If deleteFiles is checked and server has an installPath, delete the files first
      if (deleteFiles && deleteServer.installPath) {
        try {
          const result = await serversDetectApi.deleteFiles(deleteServer.installPath) as { error?: string }
          if (result?.error) {
            toast({ 
              title: t('toasts.fileDeletionFailed'),
              description: result.error,
              variant: 'destructive'
            })
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : t('toasts.couldNotDeleteServerFiles')
          toast({ 
            title: t('toasts.warning'),
            description: t('toasts.removeFromPanelAnyway', { message: msg }),
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
        title: t('toasts.deleted'),
        description: deleteFiles 
          ? t('toasts.serverAndFilesDeleted', { name: deleteServer.name })
          : t('toasts.serverRemoved', { name: deleteServer.name })
      })
      setDeleteServer(null)
      setDeleteFiles(false)
      fetchServers()
    } catch (error) {
      toast({ 
        title: t('toasts.error'),
        description: error instanceof Error ? error.message : t('toasts.failedToDeleteServer'),
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
    
    // Validate port range
    if (editingServer.rconPort < 1 || editingServer.rconPort > 65535) {
      toast({ title: t('toasts.error'), description: t('validation.rconPortRange'), variant: 'destructive' })
      return
    }
    
    setSavingEdit(true)
    try {
      await serversApi.update(editingServer.id, editingServer)
      toast({ title: t('toasts.saved'), description: t('toasts.serverSettingsUpdated') })
      setEditingServer(null)
      fetchServers()
    } catch (error) {
      toast({ 
        title: t('toasts.error'),
        description: error instanceof Error ? error.message : t('toasts.failedToUpdateServer'),
        variant: 'destructive'
      })
    } finally {
      setSavingEdit(false)
    }
  }

  // Start Steam update/verify operation
  const handleStartSteamOperation = async () => {
    if (!steamOperation || !steamcmdPath.trim()) {
      toast({ title: t('toasts.error'), description: t('validation.enterSteamcmdPath'), variant: 'destructive' })
      return
    }
    
    const installFolder = getInstallFolder(steamOperation.server.installPath)
    if (!installFolder) {
      toast({ title: t('toasts.error'), description: t('validation.installPathNotConfigured'), variant: 'destructive' })
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
    setSteamCompleted(null)
    
    try {
      if (steamOperation.type === 'verify') {
        await serversApi.steamVerify(steamcmdPath, installFolder, steamOperation.branch)
      } else {
        await serversApi.steamUpdate(steamcmdPath, installFolder, steamOperation.branch)
      }
    } catch (error) {
      setSteamRunning(false)
      toast({
        title: t('toasts.error'),
        description: error instanceof Error ? error.message : t('toasts.failedToStartOperation'),
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
    if (!steamOperation) return
    const installFolder = getInstallFolder(steamOperation.server.installPath)
    if (!installFolder) {
      toast({ title: t('toasts.error'), description: t('validation.installPathNotConfigured'), variant: 'destructive' })
      return
    }

    setClearingInstall(true)
    try {
      const result = await serversDetectApi.deleteFiles(installFolder) as { error?: string }
      if (result?.error) {
        toast({ title: t('toasts.couldNotClearFolder'), description: result.error, variant: 'destructive' })
        return
      }
      setSteamLogs([])
      setSteamCompleted(null)
      toast({
        title: t('toasts.installationFolderCleared'),
        description: t('toasts.installationFolderClearedDescription'),
      })
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: error instanceof Error ? error.message : t('toasts.failedToClearInstallationFolder'),
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
    if (/\.(bat|sh|exe)$/i.test(installPath)) {
      const lastSlash = Math.max(installPath.lastIndexOf('\\'), installPath.lastIndexOf('/'))
      return lastSlash > 0 ? installPath.substring(0, lastSlash) : installPath
    }
    return installPath
  }

  const handleAddExistingServer = async () => {
    // For remote servers, only need name, rcon credentials
    if (addMode === 'remote') {
      if (!newServer.name.trim()) {
        toast({ title: t('toasts.error'), description: t('validation.serverNameRequired'), variant: 'destructive' })
        return
      }
      if (!newServer.rconHost.trim()) {
        toast({ title: t('toasts.error'), description: t('validation.rconHostRequired'), variant: 'destructive' })
        return
      }
      if (!newServer.rconPassword.trim()) {
        toast({ title: t('toasts.error'), description: t('validation.rconPasswordRequired'), variant: 'destructive' })
        return
      }
    } else {
      // Local server validation
      if (!selectedServerConfig) {
        toast({ title: t('toasts.error'), description: t('validation.detectServerFirst'), variant: 'destructive' })
        return
      }
      if (!newServer.rconPassword.trim()) {
        toast({ title: t('toasts.error'), description: t('validation.rconPasswordConfigureIni'), variant: 'destructive' })
        return
      }
    }

    setAddingServer(true)
    try {
      const createResult = await serversApi.create({
        name: newServer.name || newServer.serverName,
        serverName: newServer.serverName,
        installPath: newServer.installPath,
        zomboidDataPath: newServer.zomboidDataPath,
        serverConfigPath: newServer.serverConfigPath,
        rconHost: newServer.rconHost,
        rconPort: newServer.rconPort,
        rconPassword: newServer.rconPassword,
        serverPort: newServer.serverPort,
        minMemory: newServer.minMemory,
        maxMemory: newServer.maxMemory,
        useNoSteam: newServer.useNoSteam,
        useDebug: newServer.useDebug,
        isRemote: addMode === 'remote'
      } as Partial<ServerInstance>)
      
      if (createResult.server?.id) {
        await serversApi.activate(createResult.server.id)
      }
      
      toast({ title: t('toasts.serverAdded'), description: t('toasts.serverAddedDescription', { name: newServer.name }) })
      setShowAddDialog(false)
      setNewServer(defaultNewServer)
      setDetectResult(null)
      setDetectError(null)
      setSelectedServerConfig('')
      fetchServers()
    } catch (error) {
      toast({ 
        title: t('toasts.error'),
        description: error instanceof Error ? error.message : t('toasts.failedToAddServer'),
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
        title={t("title")}
        description={t("description")}
        eyebrow={t('fleet')}
        tone="servers"
        icon={<Server className="w-5 h-5 text-primary" />}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => { setAddMode('remote'); setShowAddDialog(true) }}>
              <Globe className="w-4 h-4 mr-2" /> {t('ui.addRemoteServer')}
            </Button>
            <Button variant="outline" onClick={() => { setAddMode('local'); setShowAddDialog(true) }}>
              <FolderOpen className="w-4 h-4 mr-2" /> {t('ui.addExistingServer')}
            </Button>
            <Button variant="command" onClick={() => navigate('/server-setup')}>
              <Download className="w-4 h-4 mr-2" /> {t('ui.installNewServer')}
            </Button>
          </div>
        }
      />

      {/* Server Grid */}
      {servers.length === 0 ? (
        <Card className="mission-brief overflow-hidden border-primary/20 bg-card">
          <CardContent className="py-10">
            <div className="mx-auto max-w-4xl space-y-8">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
                  <Server className="h-7 w-7" />
                </div>
                <h3 className="text-xl font-semibold text-foreground">{t('noServersConfigured')}</h3>
                <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {t('onboarding.startWithOneServer')}
                </p>
              </div>

              <div className="mission-step-grid grid gap-4 md:grid-cols-3">
                <div className="mission-step-card rounded-2xl border border-border/60 bg-background/40 p-5">
                  <div className="mission-step-icon mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <FolderOpen className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">{t('addAnExistingLocalServer')}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t('onboarding.existingServerDescription')}
                  </p>
                  <Button variant="outline" className="onboarding-cta mt-4 w-full" onClick={() => { setAddMode('local'); setShowAddDialog(true) }}>
                    <FolderOpen className="mr-2 h-4 w-4" />
                    {t('ui.addExistingServer')}
                  </Button>
                </div>

                <div className="mission-step-card rounded-2xl border border-border/60 bg-background/40 p-5">
                  <div className="mission-step-icon mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <Download className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">{t('installANewLocalServer')}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t('onboarding.installNewServerDescription')}
                  </p>
                  <Button className="onboarding-cta mt-4 w-full" onClick={() => navigate('/server-setup')}>
                    <Download className="mr-2 h-4 w-4" />
                    {t('ui.installNewServer')}
                  </Button>
                </div>

                <div className="mission-step-card rounded-2xl border border-border/60 bg-background/40 p-5">
                  <div className="mission-step-icon mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <Globe className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">{t('connectARemoteServer')}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t('onboarding.remoteServerDescription')}
                  </p>
                  <Button variant="secondary" className="onboarding-cta mt-4 w-full" onClick={() => { setAddMode('remote'); setShowAddDialog(true) }}>
                    <Globe className="mr-2 h-4 w-4" />
                    {t('ui.addRemoteServer')}
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 rounded-2xl border border-border/60 bg-background/30 p-5 md:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t('step1')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{t('bringInOneServer')}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t('step2')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{t('setItActiveAndVerifyRcon')}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t('step3')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{t('returnToDashboardForLiveControl')}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 stagger-in">
          {servers.map(server => {
            const hasUpdate = updateInfo?.updateAvailable && server.isActive
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
                <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-primary via-primary/80 to-primary/40" aria-hidden="true" />
              )}
              {hasUpdate && !server.isActive && (
                <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-warning via-warning/80 to-warning/40" aria-hidden="true" />
              )}

              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <CardTitle className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="truncate">{server.name}</span>
                      {server.isActive ? (
                        <Badge variant="default" className="text-xs">
                         <Star className="w-3 h-3 mr-1" /> {t('cardStatus.active')}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                           {t('cardStatus.inactive')}
                        </Badge>
                      )}
                      {(() => {
                        const status = serverStatuses[String(server.id)]
                        if (!status) return null
                         return status.running ? (
                           <Badge variant="success" className="text-xs" title={status.pid ? t('cardStatus.pid', { pid: status.pid }) : t('cardStatus.processDetected')}>
                             <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" />
                             {t('status.running')}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs text-muted-foreground" title={t('empty.noServers')}>
                           {t('status.stopped')}
                          </Badge>
                        )
                      })()}
                      {server.isRemote && (
                        <Badge variant="outline" className="text-xs">
                           <Globe className="w-3 h-3 mr-1" /> {t('cardStatus.remote')}
                        </Badge>
                      )}
                      {hasUpdate && (
                        <Badge variant="warning" className="text-xs">
                           <RefreshCw className="w-3 h-3 mr-1" /> {t('cardStatus.updateAvailable')}
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="font-mono text-xs">
                      {server.serverName}
                    </CardDescription>
                  </div>
                  
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                       <Button variant="ghost" size="iconDense" className="shrink-0" aria-label={t('ui.optionsFor', { name: server.name || server.serverName })}>
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditingServer({ ...server })}>
                         <Edit2 className="w-4 h-4 mr-2" /> {t('ui.edit')}
                      </DropdownMenuItem>
                      {!server.isActive && (
                        <DropdownMenuItem onClick={() => handleActivateServer(server)} disabled={activating !== null}>
                          <Power className="w-4 h-4 mr-2" /> {t('ui.setActive')}
                        </DropdownMenuItem>
                      )}
                      {!server.isRemote && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => openSteamOperation(server, 'update')}>
                            <RefreshCw className="w-4 h-4 mr-2" /> {t('ui.updateServer')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openSteamOperation(server, 'verify')}>
                            <ShieldCheck className="w-4 h-4 mr-2" /> {t('ui.verifyFiles')}
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem 
                        onClick={() => setDeleteServer(server)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="w-4 h-4 mr-2" /> {t('ui.removeFromPanel')}
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
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('installPath')}</p>
                          <p className="font-mono text-xs text-foreground/85 truncate mt-0.5" title={server.installPath}>{server.installPath}</p>
                        </div>
                      </div>
                    )}
                    {server.zomboidDataPath && (
                      <div className="flex items-start gap-2.5 px-3 py-2">
                        <Database className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('dataPath')}</p>
                          <p className="font-mono text-xs text-foreground/85 truncate mt-0.5" title={server.zomboidDataPath}>{server.zomboidDataPath}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Network & Config Grid */}
                <div className={`grid ${server.isRemote ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'} gap-2`}>
                  <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
                    <div className="grid place-items-center w-7 h-7 rounded-md border border-primary/25 bg-primary/[0.06] text-primary shrink-0" aria-hidden="true">
                      <Network className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('rcon')}</p>
                      <p className="font-mono text-xs text-foreground/90 truncate tabular-nums">{server.rconHost}:{server.rconPort}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
                    <div className="grid place-items-center w-7 h-7 rounded-md border border-primary/25 bg-primary/[0.06] text-primary shrink-0" aria-hidden="true">
                      <Globe className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('gamePort')}</p>
                      <p className="font-mono text-xs text-foreground/90 tabular-nums">{server.serverPort}</p>
                    </div>
                  </div>
                  {!server.isRemote && (
                    <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
                      <div className="grid place-items-center w-7 h-7 rounded-md border border-border/55 bg-muted/40 text-muted-foreground shrink-0" aria-hidden="true">
                        <Cpu className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('memory')}</p>
                        <p className="font-mono text-xs text-foreground/90 tabular-nums">{server.minMemory}–{server.maxMemory} GB</p>
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
                          <span className="text-muted-foreground">{t('build')}</span>
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
                    <span className="text-xs text-muted-foreground">{t('branch')}</span>
                    <Badge variant="secondary" className="text-xs font-mono">{server.branch}</Badge>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex flex-wrap gap-2 pt-1">
                  {(() => {
                    const status = serverStatuses[String(server.id)]
                    const isRunning = status?.running ?? false
                    const startPending = serverActionPending === `start-${server.id}`
                    const stopPending = serverActionPending === `stop-${server.id}`
                    if (server.isRemote) return null
                    return isRunning ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleInlineStop(server)}
                        disabled={stopPending || serverActionPending !== null}
                        title={t('actions.stopServer')}
                      >
                        {stopPending ? (
                          <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> {t('status.stopping')}</>
                        ) : (
                          <><Square className="w-4 h-4 mr-1.5" /> {t('ui.stop')}</>
                        )}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleInlineStart(server)}
                        disabled={startPending || serverActionPending !== null}
                         title={server.isActive ? t('ui.startThisServer') : t('ui.switchAndStartServer')}
                      >
                        {startPending ? (
                          <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> {t('status.starting')}</>
                        ) : (
                          <><Play className="w-4 h-4 mr-1.5" /> {t('ui.start')}</>
                        )}
                      </Button>
                    )
                  })()}
                  {hasUpdate && (
                    <Button 
                      size="sm"
                      variant="warning"
                      onClick={() => openSteamOperation(server, 'update')}
                    >
                       <RefreshCw className="w-4 h-4 mr-1.5" /> {t('ui.updateNow')}
                    </Button>
                  )}
                  {!server.isActive && (
                    <Button 
                      variant="outline" 
                      size="sm"
                      className="flex-1"
                      onClick={() => handleActivateServer(server)}
                      disabled={activating === server.id}
                    >
                      {activating === server.id ? (
                         <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> {t('cardStatus.activating')}</>
                      ) : (
                         <><Power className="w-4 h-4 mr-1.5" /> {t('ui.switchToThisServer')}</>
                      )}
                    </Button>
                  )}
                </div>

                {/* Created date */}
                {server.createdAt && (
                  <p className="text-[11px] text-muted-foreground/60 pt-1">
                     {t('cardStatus.addedOn', { date: new Date(server.createdAt).toLocaleDateString() })}
                  </p>
                )}
              </CardContent>
            </Card>
          )})}
        </div>
      )}

      {/* Add Existing Server Dialog */}
      <Dialog open={showAddDialog} onOpenChange={(open) => !open && resetAddDialog()}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{addMode === 'remote' ? t('ui.addRemoteServer') : t('ui.addExistingServer')}</DialogTitle>
            <DialogDescription>
              {addMode === 'remote' 
                ? t('dialog.remoteDescription')
                : t('dialog.existingDescription')}
            </DialogDescription>
          </DialogHeader>
          
          {/* Mode Selector */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => { setAddMode('local'); setNewServer(defaultNewServer); setDetectResult(null); setDetectError(null); setSelectedServerConfig('') }}
              className={`flex items-center gap-3 p-3 rounded-lg border-2 transition-[background-color,border-color,color] ${
                addMode === 'local' 
                  ? 'border-primary bg-primary/5' 
                  : 'border-border hover:border-muted-foreground/30'
              }`}
            >
              <Monitor className={`w-5 h-5 ${addMode === 'local' ? 'text-primary' : 'text-muted-foreground'}`} />
              <div className="text-left">
                <p className="text-sm font-medium">{t('localServer')}</p>
                <p className="text-xs text-muted-foreground">{t('sameMachineAsPanel')}</p>
              </div>
            </button>
            <button
              onClick={() => { setAddMode('remote'); setNewServer({ ...defaultNewServer, isRemote: true, rconHost: '' }); setDetectResult(null); setDetectError(null); setSelectedServerConfig('') }}
              className={`flex items-center gap-3 p-3 rounded-lg border-2 transition-[background-color,border-color,color] ${
                addMode === 'remote' 
                  ? 'border-primary bg-primary/5' 
                  : 'border-border hover:border-muted-foreground/30'
              }`}
            >
              <Globe className={`w-5 h-5 ${addMode === 'remote' ? 'text-primary' : 'text-muted-foreground'}`} />
              <div className="text-left">
                <p className="text-sm font-medium">{t('remoteServer')}</p>
                <p className="text-xs text-muted-foreground">{t('rconOnlyAnotherMachine')}</p>
              </div>
            </button>
          </div>

          {/* Remote Server Info Banner */}
          {addMode === 'remote' && (
            <Alert className="border-primary/20 bg-primary/5">
              <Wifi className="h-4 w-4 text-primary" />
              <AlertTitle>{t('rcononlyConnection')}</AlertTitle>
              <AlertDescription>
                {t('dialog.remoteFeaturesDescription')}
              </AlertDescription>
            </Alert>
          )}
          
          <div className="space-y-4 py-2">
            {addMode === 'remote' ? (
              /* ========== REMOTE SERVER FORM ========== */
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('serverDisplayName')}</Label>
                  <Input
                    value={newServer.name}
                    onChange={e => setNewServer({ ...newServer, name: e.target.value })}
                    placeholder={t('placeholders.serverName')}
                    maxLength={64}
                  />
                </div>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('rconHostIp')}</Label>
                    <Input
                      value={newServer.rconHost}
                      onChange={e => setNewServer({ ...newServer, rconHost: e.target.value })}
                      placeholder={t('placeholders.serverAddress')}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">{t('theIpAddressOrHostnameOfTheRemotePzServer')}</p>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('rconPort')}</Label>
                    <Input
                      type="number"
                      value={newServer.rconPort}
                      onChange={e => setNewServer({ ...newServer, rconPort: parseInt(e.target.value) || 27015 })}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>{t('rconPassword')}</Label>
                  <Input
                    type="password"
                    value={newServer.rconPassword}
                    onChange={e => setNewServer({ ...newServer, rconPassword: e.target.value })}
                    placeholder={t('placeholders.rconPassword')}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t('gamePortOptional')}</Label>
                  <Input
                    type="number"
                    value={newServer.serverPort}
                    onChange={e => setNewServer({ ...newServer, serverPort: parseInt(e.target.value) || 16261 })}
                  />
                  <p className="text-xs text-muted-foreground">{t('thePzGamePortUsedForDisplayPurposesOnly')}</p>
                </div>
              </div>
            ) : (
              /* ========== LOCAL SERVER FORM ========== */
              <>
            {/* Auto Scan Section */}
            <div className="p-4 rounded-lg bg-muted/50 border space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{t('autoDetectServers')}</p>
                  <p className="text-xs text-muted-foreground">{t('scanAFolderToFindAllPzServersAutomatically')}</p>
                </div>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setShowAutoScan(!showAutoScan)}
                >
                  {showAutoScan ? t('scan.manualEntry') : t('scan.autoScan')}
                </Button>
              </div>
              
              {showAutoScan && (
                <div className="space-y-3 pt-2">
                  <div className="flex gap-2">
                    <Input
                      value={autoScanPath}
                      onChange={e => setAutoScanPath(e.target.value)}
                      placeholder={t('placeholders.scanPath')}
                      className="font-mono text-sm flex-1"
                    />
                    <Button 
                      onClick={handleAutoScan}
                      disabled={autoScanning || !autoScanPath.trim()}
                    >
                      {autoScanning ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <><Search className="w-4 h-4 mr-1" /> {t('scan.scan')}</>
                      )}
                    </Button>
                  </div>
                  
                  {/* Auto Scan Results */}
                  {autoScanResult && autoScanResult.detectedConfigs.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {t('scan.foundServers', { count: autoScanResult.detectedConfigs.length })}
                      </p>
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {autoScanResult.detectedConfigs.map((config, idx) => (
                          <div 
                            key={config.serverName || idx}
                            className="p-3 rounded border bg-background hover:bg-accent cursor-pointer transition-colors"
                            onClick={() => handleSelectScannedConfig(config, autoScanResult.installPaths[0])}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-medium">{config.publicName || config.serverName}</span>
                              <Badge variant="secondary" className="text-xs font-mono">
                                {config.serverName}.ini
                              </Badge>
                            </div>
                              <div className="text-xs text-muted-foreground mt-1 font-mono truncate">
                               {t('scan.dataPath')}: {config.dataPath}
                            </div>
                            {config.matchedBatFile ? (
                              <div className="mt-1 text-xs font-mono text-primary truncate">
                                 {t('scan.matchedStartupScript')}: {config.matchedBatFile}
                              </div>
                            ) : autoScanResult.installPaths.length > 0 ? (
                              <div className="mt-1 text-xs text-warning">
                                 {t('scan.noMatchingStartupScript')}
                              </div>
                            ) : (
                              <div className="mt-1 text-xs text-warning">
                                 {t('scan.noInstallPathFound')}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      
                      {/* Show available paths summary */}
                      <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                        {autoScanResult.installPaths.length > 0 && (
                           <p>{t('scan.installPathsFound', { count: autoScanResult.installPaths.length })}</p>
                        )}
                        {autoScanResult.customBatFiles && autoScanResult.customBatFiles.length > 0 && (
                           <p>{t('scan.customStartupScripts')}: {autoScanResult.customBatFiles.map(b => b.fileName).join(', ')}</p>
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
                <Label>{t('serverDataPath')}</Label>
                <div className="flex gap-2">
                  <Input
                    value={newServer.zomboidDataPath}
                    onChange={e => {
                      setNewServer({ ...newServer, zomboidDataPath: e.target.value })
                      setDetectResult(null)
                      setDetectError(null)
                    }}
                    placeholder={t('placeholders.dataPath')}
                    className="font-mono text-sm flex-1"
                    maxLength={260}
                  />
                  <Button 
                    variant="secondary" 
                    onClick={handleDetectServer}
                    disabled={detecting || !newServer.zomboidDataPath.trim()}
                  >
                    {detecting ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <><Search className="w-4 h-4 mr-1" /> {t('scan.scan')}</>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                   {t('scan.serverDataPathHint')}
                </p>
              </div>
              
              <div className="space-y-2">
                <Label>{t('serverInstallPathOptional')}</Label>
                <Input
                  value={newServer.installPath}
                  onChange={e => setNewServer({ ...newServer, installPath: e.target.value })}
                  placeholder={t('placeholders.serverPath')}
                  className="font-mono text-sm"
                  maxLength={260}
                />
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
                    <AlertTitle className="text-warning">{t('noServerConfigsFound')}</AlertTitle>
                    <AlertDescription>{t('runTheServerOnceToCreateTheIniFile')}</AlertDescription>
                  </Alert>
                ) : (
                  <>
                    {/* Server Selection (if multiple) */}
                    {detectResult.detectedServers.length > 1 && (
                      <div className="space-y-2">
                        <Label>{t('selectServerConfiguration')}</Label>
                        <Select 
                          value={selectedServerConfig} 
                          onValueChange={(val) => {
                            const config = detectResult.detectedServers.find(s => s.serverName === val)
                            if (config) handleSelectServerConfig(config)
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t('placeholders.selectServer')} />
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
                          <span className="font-medium">{t('serverDetectedSuccessfully')}</span>
                        </div>
                        
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                          <div>
                            <span className="text-muted-foreground">{t('serverName')}</span>
                            <p className="font-medium">{newServer.name}</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">{t('configFile')}</span>
                            <p className="font-mono">{newServer.serverName}.ini</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">{t('gamePort')}</span>
                            <p className="font-mono">{newServer.serverPort}</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">{t('rconPort')}</span>
                            <p className="font-mono">{newServer.rconPort}</p>
                          </div>
                        </div>
                        
                        {/* RCON Password Section */}
                        <div className="space-y-2 mt-2">
                          <Label>{t('rconPassword')}</Label>
                          <Input
                            type="password"
                            placeholder={t('placeholders.rconEnter')}
                            value={newServer.rconPassword}
                            className="bg-background"
                            onChange={e => setNewServer({ ...newServer, rconPassword: e.target.value })}
                          />
                          {!newServer.rconPassword ? (
                            <p className="text-xs text-warning">
                              {t('scan.rconPasswordRequiredHint')}{' '}<code className="rounded bg-warning/20 px-1">RCONPassword=yourpassword</code>{' '}{t('scan.inIniFile', { serverName: newServer.serverName })}
                            </p>
                          ) : (
                            <p className="flex items-center gap-1 text-xs text-primary">
                              <CheckCircle className="w-3 h-3" /> {t('scan.passwordSet')}
                            </p>
                          )}
                        </div>
                        
                        {/* Memory Configuration */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                          <div className="space-y-2">
                            <Label>{t('minMemoryGb')}</Label>
                            <Input
                              type="number"
                              min={1}
                              max={64}
                              value={newServer.minMemory}
                              className="bg-background"
                              onChange={e => setNewServer({ ...newServer, minMemory: Math.max(1, parseInt(e.target.value) || 2) })}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>{t('maxMemoryGb')}</Label>
                            <Input
                              type="number"
                              min={1}
                              max={64}
                              value={newServer.maxMemory}
                              className="bg-background"
                              onChange={e => setNewServer({ ...newServer, maxMemory: Math.max(1, parseInt(e.target.value) || 4) })}
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
              {t('actions.cancel')}
            </Button>
            <Button 
              onClick={handleAddExistingServer} 
              disabled={addingServer || (addMode === 'local' ? (!selectedServerConfig || !newServer.rconPassword) : (!newServer.name || !newServer.rconHost || !newServer.rconPassword))}
            >
              {addingServer ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t('cardStatus.adding')}</>
              ) : (
                <><Plus className="w-4 h-4 mr-2" /> {t('actions.addServer')}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editingServer} onOpenChange={() => setEditingServer(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('editServer')}</DialogTitle>
            <DialogDescription>
              {t('dialog.editDescription')}
            </DialogDescription>
          </DialogHeader>
          
          {editingServer && (
            <div className="space-y-4">
              {/* Remote server indicator */}
              {editingServer.isRemote && (
                <Alert className="border-primary/20 bg-primary/5">
                  <Globe className="h-4 w-4 text-primary" />
                  <AlertTitle>{t('remoteServer')}</AlertTitle>
                  <AlertDescription>{t('rcononlyManagementIsAvailableForThisServer')}</AlertDescription>
                </Alert>
              )}
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('displayName')}</Label>
                  <Input
                    value={editingServer.name}
                    onChange={e => setEditingServer({ ...editingServer, name: e.target.value })}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('serverName')}</Label>
                  <Input
                    value={editingServer.serverName}
                    onChange={e => setEditingServer({ ...editingServer, serverName: e.target.value })}
                    maxLength={64}
                  />
                </div>
              </div>
              
              {!editingServer.isRemote && (
              <>
              <div className="space-y-2">
                <Label>{t('installPath')}</Label>
                <Input
                  value={editingServer.installPath}
                  onChange={e => setEditingServer({ ...editingServer, installPath: e.target.value })}
                  className="font-mono text-sm"
                />
              </div>
              
              <div className="space-y-2">
                <Label>{t('zomboidDataPath')}</Label>
                <Input
                  value={editingServer.zomboidDataPath || ''}
                  onChange={e => setEditingServer({ ...editingServer, zomboidDataPath: e.target.value })}
                  className="font-mono text-sm"
                  placeholder={t('placeholders.defaultArgs')}
                />
              </div>
              
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5">
                  {t('extraLabels.customStartCommand')}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[280px]">
                      <p className="text-xs">{t('overrideTheDefaultStartupScriptWithACustomCommandSupportsArgumentsLeaveEmptyToUseTheDefaultBatshFileDetection')}</p>
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Input
                  value={editingServer.startCommand || ''}
                  onChange={e => setEditingServer({ ...editingServer, startCommand: e.target.value })}
                  className="font-mono text-sm"
                  placeholder={t('placeholders.customArgs')}
                  maxLength={1024}
                />
                {editingServer.startCommand && /[&|;<>`${}()!\[\]]/.test(editingServer.startCommand) && (
                  <p className="text-xs text-destructive">{t('commandContainsDisallowedShellCharacters')}</p>
                )}
              </div>
              </>
              )}
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    {t('extraLabels.rconHost')}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[200px]">
                        <p className="text-xs">{t('leaveAs127001IfThePanelRunsOnTheSameMachineAsTheGameServer')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <Input
                    value={editingServer.rconHost}
                    onChange={e => setEditingServer({ ...editingServer, rconHost: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('rconPort')}</Label>
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
                  <Label>{t('rconPassword')}</Label>
                  <Input
                    type="password"
                    value={editingServer.rconPassword}
                    onChange={e => setEditingServer({ ...editingServer, rconPassword: e.target.value })}
                  />
                </div>
                {!editingServer.isRemote && (
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    {t('extraLabels.adminPassword')}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[240px]">
                        <p className="text-xs">{t('serverAdminPasswordPassedAsAdminpasswordLaunchArgumentTakesEffectOnNextServerStart')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <Input
                    type="password"
                    value={editingServer.adminPassword || ''}
                    onChange={e => setEditingServer({ ...editingServer, adminPassword: e.target.value })}
                    placeholder={t('placeholders.adminPassword')}
                  />
                </div>
                )}
              </div>
              
              <div className={editingServer.isRemote ? "grid grid-cols-1 gap-4" : "grid grid-cols-1 sm:grid-cols-3 gap-4"}>
                <div className="space-y-2">
                  <Label>{t('gamePort')}</Label>
                  <Input
                    type="number"
                    value={editingServer.serverPort}
                    onChange={e => setEditingServer({ ...editingServer, serverPort: parseInt(e.target.value) || 16261 })}
                  />
                </div>
                {!editingServer.isRemote && (
                <>
                <div className="space-y-2">
                  <Label>{t('minMemoryGb')}</Label>
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    value={editingServer.minMemory}
                    onChange={e => setEditingServer({ ...editingServer, minMemory: Math.max(1, parseInt(e.target.value) || 2) })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('maxMemoryGb')}</Label>
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    value={editingServer.maxMemory}
                    onChange={e => setEditingServer({ ...editingServer, maxMemory: Math.max(1, parseInt(e.target.value) || 4) })}
                  />
                </div>
                </>
                )}
              </div>
            </div>
          )}
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingServer(null)}>
              {t('actions.cancel')}
            </Button>
            <Button onClick={handleSaveEdit} disabled={savingEdit}>
              <Check className="w-4 h-4 mr-2" /> {savingEdit ? t('cardStatus.saving') : t('extraActions.saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteServer} onOpenChange={(open) => { if (!open && !deleting) { setDeleteServer(null); setDeleteFiles(false); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeServerFromPanel')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p>{t('delete.removeDescription', { name: deleteServer?.name || '' })}</p>
                
                {deleteServer?.installPath && (
                  <div className="flex items-start gap-3 p-3 rounded-lg border bg-muted/50">
                    <Checkbox
                      id="deleteFiles"
                      checked={deleteFiles}
                      onCheckedChange={(checked) => setDeleteFiles(checked === true)}
                      disabled={deleting}
                      className="mt-1"
                    />
                    <label htmlFor="deleteFiles" className="text-sm cursor-pointer">
                      <span className="font-medium text-destructive">{t('alsoDeleteServerFiles')}</span>
                      <p className="text-muted-foreground mt-1">
                         {t('delete.permanentDeleteDescription')}<br />
                        <code className="text-xs bg-background px-1 rounded">{deleteServer?.installPath}</code>
                      </p>
                    </label>
                  </div>
                )}
                
                {!deleteFiles && !deleting && (
                  <p className="text-sm text-muted-foreground">
                    {t('delete.filesWillBeRetained')}
                  </p>
                )}

                {deleting && (
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>{deleteFiles ? t('cardStatus.deletingFiles') : t('cardStatus.removingServer')}</span>
                    </div>
                    <Progress value={deleteProgress} className="h-1.5" />
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('cancel')}</AlertDialogCancel>
            <Button 
              onClick={handleDeleteServer} 
              disabled={deleting}
              className={deleteFiles ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
            >
              {deleting ? (
                <><Loader2 className="w-4 h-4 animate-spin mr-2" />{t('cardStatus.removing')}</>
              ) : deleteFiles ? t('extraActions.deleteEverything') : t('ui.removeFromPanel')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Steam Update/Verify Dialog */}
      <Dialog open={!!steamOperation} onOpenChange={(open) => !open && !steamRunning && setSteamOperation(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {steamOperation?.type === 'verify' ? (
                <><ShieldCheck className="w-5 h-5" /> {t('steam.verifyGameFiles')}</>
              ) : (
                <><RefreshCw className="w-5 h-5" /> {t('ui.updateServer')}</>
              )}
            </DialogTitle>
            <DialogDescription>
              {steamOperation?.type === 'verify' 
                ? t('steam.verifyDescription')
                : t('steam.updateDescription')
              }
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t('steamcmdPath')}</Label>
              <Input
                value={steamcmdPath}
                onChange={e => setSteamcmdPath(e.target.value)}
                placeholder={t('placeholders.steamcmdPath')}
                className="font-mono text-sm"
                disabled={steamRunning}
              />
              <p className="text-xs text-muted-foreground">
                {t('steam.folderHint')}
              </p>
            </div>
            
            <div className="space-y-2">
              <Label>{t('serverInstallPath')}</Label>
              <Input
                value={getInstallFolder(steamOperation?.server.installPath)}
                disabled
                className="font-mono text-sm bg-muted"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={steamRunning || clearingInstall}
                onClick={() => setConfirmClearInstall(true)}
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" /> {t('extraActions.clearInstallationFolder')}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('steam.clearInstallationDescription')}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t('steam.branchLabel')} {loadingBranches && <Loader2 className="inline-block w-3 h-3 ml-1 animate-spin" />}</Label>
              <Select 
                value={steamOperation?.branch || 'public'} 
                onValueChange={(value) => steamOperation && setSteamOperation({ ...steamOperation, branch: value })}
                disabled={steamRunning || loadingBranches}
              >
                <SelectTrigger className="w-full text-foreground">
                  {(() => {
                    const current = availableBranches.find(b => b.name === steamOperation?.branch)
                    if (loadingBranches) return <span className="text-muted-foreground">{t('loadingBranches')}</span>
                    if (!current) return <span className="text-muted-foreground">{t('selectBranch')}</span>
                    return (
                      <span className="flex items-center gap-2">
                        <span className="capitalize">{getBranchLabel(current.name)}</span>
                        {(() => {
                          const sb = (steamOperation?.server.branch || '').trim().toLowerCase()
                          const ib = (updateInfo?.installed?.branch || '').trim().toLowerCase()
                          const isCurrent = current.name === ib || current.name === sb
                          return isCurrent ? (
                            <span className="rounded border border-border/60 px-1 py-px font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{t('current')}</span>
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
                        <span className="capitalize">{getBranchLabel(b.name)}</span>
                        {getBranchDescription(b) && <span className="text-xs text-muted-foreground">{getBranchDescription(b)}</span>}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {(() => {
                  const selected = availableBranches.find(b => b.name === steamOperation?.branch)
                   if (!selected) return t('steam.selectBranchHint')
                   const details = [getBranchDescription(selected)]
                   if (selected.buildId) details.push(t('steam.build', { buildId: selected.buildId }))
                   if (selected.timeUpdated) details.push(t('steam.updated', { date: new Date(selected.timeUpdated).toLocaleString() }))
                  return details.join(' - ')
                })()}
              </p>
            </div>
            
            {steamLogs.length > 0 && (
              <div className="space-y-2">
                <Label>{t('progress')}</Label>
                <div className="h-48 overflow-y-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs text-foreground">
                  {steamLogs.map((log, i) => (
                    <div key={i}>{log}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
          
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setSteamOperation(null)}
              disabled={steamRunning}
            >
              {steamRunning ? t('cardStatus.runningEllipsis') : steamCompleted ? t('extraActions.close') : t('actions.cancel')}
            </Button>
            {!steamCompleted && (
              <Button 
                onClick={handleStartSteamOperation}
                disabled={steamRunning || !steamcmdPath.trim()}
              >
                {steamRunning ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t('cardStatus.runningEllipsis')}</>
                ) : steamOperation?.type === 'verify' ? (
                  <><ShieldCheck className="w-4 h-4 mr-2" /> {t('steam.startVerify')}</>
                ) : (
                  <><RefreshCw className="w-4 h-4 mr-2" /> {t('steam.startUpdate')}</>
                )}
              </Button>
            )}
            {steamCompleted === 'success' && (
              <Button 
                variant="default"
                onClick={() => setSteamOperation(null)}
              >
                <CheckCircle2 className="w-4 h-4 mr-2" /> {t('extraActions.done')}
              </Button>
            )}
            {steamCompleted === 'error' && (
              <Button 
                onClick={() => { setSteamCompleted(null); handleStartSteamOperation(); }}
                disabled={!steamcmdPath.trim()}
              >
                <RefreshCw className="w-4 h-4 mr-2" /> {t('extraActions.retry')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear Installation Folder confirmation */}
      <AlertDialog open={confirmClearInstall} onOpenChange={(open) => !open && !clearingInstall && setConfirmClearInstall(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('clearInstallationFolder')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('steam.clearFolderWarningBeforePath')}{' '}
              <code className="text-xs bg-background px-1 rounded">
                {getInstallFolder(steamOperation?.server.installPath)}
              </code>
              {' '}{t('steam.clearFolderWarningAfterPath')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearingInstall}>{t('cancel')}</AlertDialogCancel>
            <Button
              onClick={handleClearInstallFolder}
              disabled={clearingInstall}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {clearingInstall ? (
                 <><Loader2 className="w-4 h-4 animate-spin mr-2" />{t('cardStatus.clearing')}</>
              ) : (
                 <><Trash2 className="w-4 h-4 mr-2" />{t('extraActions.clearFolder')}</>
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
