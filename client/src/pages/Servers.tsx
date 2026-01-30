import { useState, useEffect, useContext } from 'react'
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
  RefreshCw,
  ShieldCheck
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Badge } from '@/components/ui/badge'
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
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { serversApi, ServerInstance, configApi, serverApi } from '@/lib/api'
import { SocketContext } from '@/contexts/SocketContext'
import { useNavigate } from 'react-router-dom'

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
  minMemory: 2048,
  maxMemory: 4096,
  useNoSteam: false,
  useDebug: false
}

export default function Servers() {
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [editingServer, setEditingServer] = useState<ServerInstance | null>(null)
  const [deleteServer, setDeleteServer] = useState<ServerInstance | null>(null)
  const [activating, setActivating] = useState<number | null>(null)
  
  // Add server dialog
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newServer, setNewServer] = useState<NewServerForm>(defaultNewServer)
  const [addingServer, setAddingServer] = useState(false)
  
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
  const [steamcmdPath, setSteamcmdPath] = useState('')
  const [availableBranches, setAvailableBranches] = useState<Array<{name: string, description: string, buildId?: string | null}>>([
    { name: 'stable', description: 'Stable release' },
    { name: 'unstable', description: 'Unstable beta' }
  ])
  const [loadingBranches, setLoadingBranches] = useState(false)
  
  const { toast } = useToast()
  const socket = useContext(SocketContext)
  const navigate = useNavigate()

  // Fetch servers
  const fetchServers = async () => {
    try {
      const data = await serversApi.getAll()
      setServers(data.servers || [])
    } catch (error) {
      console.error('Failed to fetch servers:', error)
      toast({ title: 'Error', description: 'Failed to load servers', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  // Load steamcmd path and servers on mount
  useEffect(() => {
    fetchServers()
    // Load steamcmd path from settings
    configApi.getAppSettings().then(data => {
      if (data.settings?.steamcmdPath) {
        setSteamcmdPath(data.settings.steamcmdPath)
      }
    }).catch(() => {})
  }, [])

  // Fetch available Steam branches when steam operation dialog opens
  useEffect(() => {
    if (!steamOperation) return
    
    const fetchBranches = async () => {
      setLoadingBranches(true)
      try {
        const data = await serverApi.getBranches(steamcmdPath)
        if (data.branches && Array.isArray(data.branches)) {
          setAvailableBranches(data.branches)
        }
      } catch (error) {
        console.error('Failed to fetch branches:', error)
        // Keep default branches on error
      } finally {
        setLoadingBranches(false)
      }
    }
    
    fetchBranches()
  }, [steamOperation?.server?.id, steamcmdPath])

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
  }, [socket])

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
      setSteamLogs(prev => [...prev, '', data.success ? '✓ ' + data.message : '✗ ' + data.message])
      toast({
        title: data.success ? 'Success' : 'Failed',
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
  }, [socket, toast])

  // Detect server settings from data path
  const handleDetectServer = async () => {
    if (!newServer.zomboidDataPath.trim()) {
      toast({ title: 'Error', description: 'Please enter the server data path first', variant: 'destructive' })
      return
    }
    
    setDetecting(true)
    setDetectError(null)
    setDetectResult(null)
    setSelectedServerConfig('')
    
    try {
      const response = await fetch('/api/servers/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          dataPath: newServer.zomboidDataPath,
          installPath: newServer.installPath || undefined
        })
      })
      
      const data = await response.json()
      
      if (!response.ok) {
        setDetectError(data.error || 'Detection failed')
        return
      }
      
      setDetectResult(data)
      
      // Auto-select first server if only one
      if (data.detectedServers.length === 1) {
        handleSelectServerConfig(data.detectedServers[0], data)
      } else if (data.detectedServers.length > 1) {
        toast({ 
          title: 'Multiple servers found', 
          description: 'Please select which server configuration to use'
        })
      }
      
      // Update useNoSteam based on detection
      if (data.hasNoSteam) {
        setNewServer(prev => ({ ...prev, useNoSteam: true }))
      }
      
    } catch (error) {
      setDetectError(error instanceof Error ? error.message : 'Detection failed')
    } finally {
      setDetecting(false)
    }
  }
  
  // Auto-scan a folder to find all PZ server paths
  const handleAutoScan = async () => {
    if (!autoScanPath.trim()) {
      toast({ title: 'Error', description: 'Please enter a folder path to scan', variant: 'destructive' })
      return
    }
    
    setAutoScanning(true)
    setAutoScanResult(null)
    
    try {
      const response = await fetch('/api/servers/auto-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanPath: autoScanPath, maxDepth: 4 })
      })
      
      const data = await response.json()
      
      if (!response.ok) {
        toast({ title: 'Scan Failed', description: data.error, variant: 'destructive' })
        return
      }
      
      setAutoScanResult(data)
      
      if (data.detectedConfigs.length === 0) {
        toast({ 
          title: 'No servers found', 
          description: 'No Project Zomboid servers were found in the scanned folder'
        })
      } else {
        toast({ 
          title: 'Servers found!', 
          description: `Found ${data.detectedConfigs.length} server configuration(s)`
        })
      }
      
    } catch (error) {
      toast({ 
        title: 'Scan Failed', 
        description: error instanceof Error ? error.message : 'Auto-scan failed', 
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
        title: 'RCON not configured',
        description: 'This server has no RCON password set. You\'ll need to configure it in the server INI file.',
        variant: 'destructive'
      })
    }
  }

  const handleActivateServer = async (server: ServerInstance) => {
    if (server.isActive) return
    
    setActivating(server.id)
    try {
      await serversApi.activate(server.id)
      toast({ 
        title: 'Server Activated', 
        description: `Now managing: ${server.name}` 
      })
      fetchServers()
    } catch (error) {
      toast({ 
        title: 'Error', 
        description: error instanceof Error ? error.message : 'Failed to activate server',
        variant: 'destructive'
      })
    } finally {
      setActivating(null)
    }
  }

  const handleDeleteServer = async () => {
    if (!deleteServer) return
    
    try {
      await serversApi.delete(deleteServer.id)
      toast({ title: 'Deleted', description: `Server "${deleteServer.name}" removed from panel` })
      setDeleteServer(null)
      fetchServers()
    } catch (error) {
      toast({ 
        title: 'Error', 
        description: error instanceof Error ? error.message : 'Failed to delete server',
        variant: 'destructive'
      })
    }
  }

  const handleSaveEdit = async () => {
    if (!editingServer) return
    
    try {
      await serversApi.update(editingServer.id, editingServer)
      toast({ title: 'Saved', description: 'Server settings updated' })
      setEditingServer(null)
      fetchServers()
    } catch (error) {
      toast({ 
        title: 'Error', 
        description: error instanceof Error ? error.message : 'Failed to update server',
        variant: 'destructive'
      })
    }
  }

  // Start Steam update/verify operation
  const handleStartSteamOperation = async () => {
    if (!steamOperation || !steamcmdPath.trim()) {
      toast({ title: 'Error', description: 'Please enter the SteamCMD path', variant: 'destructive' })
      return
    }
    
    const installFolder = getInstallFolder(steamOperation.server.installPath)
    if (!installFolder) {
      toast({ title: 'Error', description: 'Server install path not configured', variant: 'destructive' })
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
    
    try {
      if (steamOperation.type === 'verify') {
        await serversApi.steamVerify(steamcmdPath, installFolder, steamOperation.branch)
      } else {
        await serversApi.steamUpdate(steamcmdPath, installFolder, steamOperation.branch)
      }
    } catch (error) {
      setSteamRunning(false)
      toast({ 
        title: 'Error', 
        description: error instanceof Error ? error.message : 'Failed to start operation',
        variant: 'destructive'
      })
    }
  }
  
  // Open steam operation dialog
  const openSteamOperation = async (server: ServerInstance, type: 'update' | 'verify') => {
    setSteamOperation({ server, type, branch: server.branch || 'stable' })
    setSteamLogs([])
    setSteamRunning(false)
    
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
    // If path ends with .bat, get the parent folder
    if (installPath.toLowerCase().endsWith('.bat')) {
      const lastSlash = Math.max(installPath.lastIndexOf('\\'), installPath.lastIndexOf('/'))
      return lastSlash > 0 ? installPath.substring(0, lastSlash) : installPath
    }
    return installPath
  }

  const handleAddExistingServer = async () => {
    // Validation - all fields should be auto-detected now
    if (!selectedServerConfig) {
      toast({ title: 'Error', description: 'Please detect a server first', variant: 'destructive' })
      return
    }
    if (!newServer.rconPassword.trim()) {
      toast({ title: 'Error', description: 'RCON password is required. Configure it in your server INI file first.', variant: 'destructive' })
      return
    }

    setAddingServer(true)
    try {
      await serversApi.create({
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
        useDebug: newServer.useDebug
      })
      
      toast({ title: 'Server Added', description: `"${newServer.name}" added to panel` })
      setShowAddDialog(false)
      setNewServer(defaultNewServer)
      setDetectResult(null)
      setDetectError(null)
      setSelectedServerConfig('')
      fetchServers()
    } catch (error) {
      toast({ 
        title: 'Error', 
        description: error instanceof Error ? error.message : 'Failed to add server',
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
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Managed Servers</h1>
          <p className="text-muted-foreground">
            Manage multiple Project Zomboid servers from one panel
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setShowAddDialog(true)}>
            <FolderOpen className="w-4 h-4 mr-2" /> Add Existing Server
          </Button>
          <Button onClick={() => navigate('/server-setup')}>
            <Download className="w-4 h-4 mr-2" /> Install New Server
          </Button>
        </div>
      </div>

      {/* Server Grid */}
      {servers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Server className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="font-semibold mb-2">No Servers Configured</h3>
            <p className="text-muted-foreground mb-4">
              Add an existing server or install a new one to get started
            </p>
            <div className="flex items-center justify-center gap-2">
              <Button variant="outline" onClick={() => setShowAddDialog(true)}>
                <FolderOpen className="w-4 h-4 mr-2" /> Add Existing Server
              </Button>
              <Button onClick={() => navigate('/server-setup')}>
                <Download className="w-4 h-4 mr-2" /> Install New Server
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {servers.map(server => (
            <Card 
              key={server.id} 
              className={server.isActive ? 'border-primary ring-1 ring-primary/20' : ''}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2">
                      {server.name}
                      {server.isActive && (
                        <Badge variant="default" className="text-xs">
                          <Star className="w-3 h-3 mr-1" /> Active
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="font-mono text-xs">
                      {server.serverName}
                    </CardDescription>
                  </div>
                  
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditingServer({ ...server })}>
                        <Edit2 className="w-4 h-4 mr-2" /> Edit
                      </DropdownMenuItem>
                      {!server.isActive && (
                        <DropdownMenuItem onClick={() => handleActivateServer(server)}>
                          <Power className="w-4 h-4 mr-2" /> Set Active
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => openSteamOperation(server, 'update')}>
                        <RefreshCw className="w-4 h-4 mr-2" /> Update Server
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => openSteamOperation(server, 'verify')}>
                        <ShieldCheck className="w-4 h-4 mr-2" /> Verify Files
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem 
                        onClick={() => setDeleteServer(server)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="w-4 h-4 mr-2" /> Remove from Panel
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              
              <CardContent className="space-y-3">
                <div className="text-sm space-y-1">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Data Path:</span>
                    <span className="font-mono text-xs truncate max-w-[180px]" title={server.zomboidDataPath || 'Default'}>
                      {server.zomboidDataPath || 'Default'}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>RCON:</span>
                    <span className="font-mono text-xs">{server.rconHost}:{server.rconPort}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Game Port:</span>
                    <span className="font-mono text-xs">{server.serverPort}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Memory:</span>
                    <span className="font-mono text-xs">{server.minMemory}MB - {server.maxMemory}MB</span>
                  </div>
                </div>
                
                {!server.isActive && (
                  <Button 
                    variant="outline" 
                    className="w-full"
                    onClick={() => handleActivateServer(server)}
                    disabled={activating === server.id}
                  >
                    {activating === server.id ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Activating...</>
                    ) : (
                      <><Power className="w-4 h-4 mr-2" /> Switch to This Server</>
                    )}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add Existing Server Dialog */}
      <Dialog open={showAddDialog} onOpenChange={(open) => !open && resetAddDialog()}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Existing Server</DialogTitle>
            <DialogDescription>
              Scan a folder to auto-detect server paths, or enter them manually
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {/* Auto Scan Section */}
            <div className="p-4 rounded-lg bg-muted/50 border space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">Auto Detect Servers</p>
                  <p className="text-xs text-muted-foreground">Scan a folder to find all PZ servers automatically</p>
                </div>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setShowAutoScan(!showAutoScan)}
                >
                  {showAutoScan ? 'Manual Entry' : 'Auto Scan'}
                </Button>
              </div>
              
              {showAutoScan && (
                <div className="space-y-3 pt-2">
                  <div className="flex gap-2">
                    <Input
                      value={autoScanPath}
                      onChange={e => setAutoScanPath(e.target.value)}
                      placeholder="E:\PZ or C:\Servers\Zomboid"
                      className="font-mono text-sm flex-1"
                    />
                    <Button 
                      onClick={handleAutoScan}
                      disabled={autoScanning || !autoScanPath.trim()}
                    >
                      {autoScanning ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <><Search className="w-4 h-4 mr-1" /> Scan</>
                      )}
                    </Button>
                  </div>
                  
                  {/* Auto Scan Results */}
                  {autoScanResult && autoScanResult.detectedConfigs.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Found {autoScanResult.detectedConfigs.length} server(s). Click to select:
                      </p>
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {autoScanResult.detectedConfigs.map((config, idx) => (
                          <div 
                            key={idx}
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
                              📁 Data: {config.dataPath}
                            </div>
                            {config.matchedBatFile ? (
                              <div className="text-xs text-green-500 mt-1 font-mono truncate">
                                ✓ Matched: {config.matchedBatFile}
                              </div>
                            ) : autoScanResult.installPaths.length > 0 ? (
                              <div className="text-xs text-yellow-500 mt-1">
                                ⚠ No matching .bat file - will use default install path
                              </div>
                            ) : (
                              <div className="text-xs text-orange-500 mt-1">
                                ⚠ No install path found - enter manually below
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      
                      {/* Show available paths summary */}
                      <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
                        {autoScanResult.installPaths.length > 0 && (
                          <p>📁 Install paths found: {autoScanResult.installPaths.length}</p>
                        )}
                        {autoScanResult.customBatFiles && autoScanResult.customBatFiles.length > 0 && (
                          <p>🎯 Custom .bat files: {autoScanResult.customBatFiles.map(b => b.fileName).join(', ')}</p>
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
                <Label>Server Data Path *</Label>
                <div className="flex gap-2">
                  <Input
                    value={newServer.zomboidDataPath}
                    onChange={e => {
                      setNewServer({ ...newServer, zomboidDataPath: e.target.value })
                      setDetectResult(null)
                      setDetectError(null)
                    }}
                    placeholder="C:\Users\YourName\Zomboid"
                    className="font-mono text-sm flex-1"
                  />
                  <Button 
                    variant="secondary" 
                    onClick={handleDetectServer}
                    disabled={detecting || !newServer.zomboidDataPath.trim()}
                  >
                    {detecting ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <><Search className="w-4 h-4 mr-1" /> Detect</>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  The folder containing Server/, Saves/, Logs/ subfolders
                </p>
              </div>
              
              <div className="space-y-2">
                <Label>Server Install Path (Optional)</Label>
                <Input
                  value={newServer.installPath}
                  onChange={e => setNewServer({ ...newServer, installPath: e.target.value })}
                  placeholder="D:\Servers\ProjectZomboid (folder with StartServer64.bat)"
                  className="font-mono text-sm"
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
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-600">
                    <AlertCircle className="w-4 h-4" />
                    <span className="text-sm">No server configs found. Run the server once to create the INI file.</span>
                  </div>
                ) : (
                  <>
                    {/* Server Selection (if multiple) */}
                    {detectResult.detectedServers.length > 1 && (
                      <div className="space-y-2">
                        <Label>Select Server Configuration</Label>
                        <Select 
                          value={selectedServerConfig} 
                          onValueChange={(val) => {
                            const config = detectResult.detectedServers.find(s => s.serverName === val)
                            if (config) handleSelectServerConfig(config)
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a server..." />
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
                      <div className="space-y-3 p-4 rounded-lg bg-muted/50 border">
                        <div className="flex items-center gap-2 text-green-600 mb-3">
                          <CheckCircle className="w-4 h-4" />
                          <span className="font-medium">Server detected successfully!</span>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <span className="text-muted-foreground">Server Name:</span>
                            <p className="font-medium">{newServer.name}</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Config File:</span>
                            <p className="font-mono">{newServer.serverName}.ini</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Game Port:</span>
                            <p className="font-mono">{newServer.serverPort}</p>
                          </div>
                          <div>
                            <span className="text-muted-foreground">RCON Port:</span>
                            <p className="font-mono">{newServer.rconPort}</p>
                          </div>
                        </div>
                        
                        {/* RCON Password Section */}
                        <div className="space-y-2 mt-2">
                          <Label>RCON Password *</Label>
                          <Input
                            type="password"
                            placeholder="Enter RCON password"
                            value={newServer.rconPassword}
                            className="bg-background"
                            onChange={e => setNewServer({ ...newServer, rconPassword: e.target.value })}
                          />
                          {!newServer.rconPassword ? (
                            <p className="text-xs text-amber-600">
                              Required for server control. You can also set <code className="bg-amber-500/20 px-1 rounded">RCONPassword=yourpassword</code> in your {newServer.serverName}.ini file.
                            </p>
                          ) : (
                            <p className="text-xs text-green-600 flex items-center gap-1">
                              <CheckCircle className="w-3 h-3" /> Password set
                            </p>
                          )}
                        </div>
                        
                        {/* Memory Configuration */}
                        <div className="grid grid-cols-2 gap-3 mt-2">
                          <div className="space-y-2">
                            <Label>Min Memory (GB)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={64}
                              value={newServer.minMemory / 1024}
                              className="bg-background"
                              onChange={e => setNewServer({ ...newServer, minMemory: Math.max(1, parseInt(e.target.value) || 2) * 1024 })}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Max Memory (GB)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={64}
                              value={newServer.maxMemory / 1024}
                              className="bg-background"
                              onChange={e => setNewServer({ ...newServer, maxMemory: Math.max(1, parseInt(e.target.value) || 4) * 1024 })}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={resetAddDialog}>
              Cancel
            </Button>
            <Button 
              onClick={handleAddExistingServer} 
              disabled={addingServer || !selectedServerConfig || !newServer.rconPassword}
            >
              {addingServer ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Adding...</>
              ) : (
                <><Plus className="w-4 h-4 mr-2" /> Add Server</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editingServer} onOpenChange={() => setEditingServer(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Server</DialogTitle>
            <DialogDescription>
              Update server configuration settings
            </DialogDescription>
          </DialogHeader>
          
          {editingServer && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Display Name</Label>
                  <Input
                    value={editingServer.name}
                    onChange={e => setEditingServer({ ...editingServer, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Server Name</Label>
                  <Input
                    value={editingServer.serverName}
                    onChange={e => setEditingServer({ ...editingServer, serverName: e.target.value })}
                  />
                </div>
              </div>
              
              <div className="space-y-2">
                <Label>Install Path</Label>
                <Input
                  value={editingServer.installPath}
                  onChange={e => setEditingServer({ ...editingServer, installPath: e.target.value })}
                  className="font-mono text-sm"
                />
              </div>
              
              <div className="space-y-2">
                <Label>Zomboid Data Path</Label>
                <Input
                  value={editingServer.zomboidDataPath || ''}
                  onChange={e => setEditingServer({ ...editingServer, zomboidDataPath: e.target.value })}
                  className="font-mono text-sm"
                  placeholder="Leave empty for default"
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>RCON Host</Label>
                  <Input
                    value={editingServer.rconHost}
                    onChange={e => setEditingServer({ ...editingServer, rconHost: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>RCON Port</Label>
                  <Input
                    type="number"
                    value={editingServer.rconPort}
                    onChange={e => setEditingServer({ ...editingServer, rconPort: parseInt(e.target.value) || 27015 })}
                  />
                </div>
              </div>
              
              <div className="space-y-2">
                <Label>RCON Password</Label>
                <Input
                  type="password"
                  value={editingServer.rconPassword}
                  onChange={e => setEditingServer({ ...editingServer, rconPassword: e.target.value })}
                />
              </div>
              
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Game Port</Label>
                  <Input
                    type="number"
                    value={editingServer.serverPort}
                    onChange={e => setEditingServer({ ...editingServer, serverPort: parseInt(e.target.value) || 16261 })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Min Memory (GB)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    value={Math.round(editingServer.minMemory / 1024)}
                    onChange={e => setEditingServer({ ...editingServer, minMemory: Math.max(1, parseInt(e.target.value) || 2) * 1024 })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Max Memory (GB)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={64}
                    value={Math.round(editingServer.maxMemory / 1024)}
                    onChange={e => setEditingServer({ ...editingServer, maxMemory: Math.max(1, parseInt(e.target.value) || 4) * 1024 })}
                  />
                </div>
              </div>
            </div>
          )}
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingServer(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit}>
              <Check className="w-4 h-4 mr-2" /> Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteServer} onOpenChange={() => setDeleteServer(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Server from Panel?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove "{deleteServer?.name}" from the panel. The actual server files will NOT be deleted - you can add it back later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteServer} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Steam Update/Verify Dialog */}
      <Dialog open={!!steamOperation} onOpenChange={(open) => !open && !steamRunning && setSteamOperation(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {steamOperation?.type === 'verify' ? (
                <><ShieldCheck className="w-5 h-5" /> Verify Game Files</>
              ) : (
                <><RefreshCw className="w-5 h-5" /> Update Server</>
              )}
            </DialogTitle>
            <DialogDescription>
              {steamOperation?.type === 'verify' 
                ? 'Check and repair game files using SteamCMD'
                : 'Download the latest version using SteamCMD'
              }
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>SteamCMD Path *</Label>
              <Input
                value={steamcmdPath}
                onChange={e => setSteamcmdPath(e.target.value)}
                placeholder="D:\SteamCMD"
                className="font-mono text-sm"
                disabled={steamRunning}
              />
              <p className="text-xs text-muted-foreground">
                Folder containing steamcmd.exe
              </p>
            </div>
            
            <div className="space-y-2">
              <Label>Server Install Path</Label>
              <Input
                value={getInstallFolder(steamOperation?.server.installPath)}
                disabled
                className="font-mono text-sm bg-muted"
              />
            </div>
            
            <div className="space-y-2">
              <Label>Steam Branch {loadingBranches && <Loader2 className="inline-block w-3 h-3 ml-1 animate-spin" />}</Label>
              <Select 
                value={steamOperation?.branch || 'stable'} 
                onValueChange={(value) => steamOperation && setSteamOperation({ ...steamOperation, branch: value })}
                disabled={steamRunning || loadingBranches}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={loadingBranches ? "Loading branches..." : "Select branch"} />
                </SelectTrigger>
                <SelectContent>
                  {availableBranches.map((b) => (
                    <SelectItem key={b.name} value={b.name}>
                      <div className="flex flex-col">
                        <span className="capitalize">{b.name === 'public' ? 'Public (Stable)' : b.name}</span>
                        {b.description && <span className="text-xs text-muted-foreground">{b.description}</span>}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Select the Steam beta branch to download from
              </p>
            </div>
            
            {steamLogs.length > 0 && (
              <div className="space-y-2">
                <Label>Progress</Label>
                <div className="bg-black rounded-lg p-3 h-48 overflow-y-auto font-mono text-xs text-green-400">
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
              {steamRunning ? 'Running...' : 'Cancel'}
            </Button>
            <Button 
              onClick={handleStartSteamOperation}
              disabled={steamRunning || !steamcmdPath.trim()}
            >
              {steamRunning ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Running...</>
              ) : steamOperation?.type === 'verify' ? (
                <><ShieldCheck className="w-4 h-4 mr-2" /> Start Verify</>
              ) : (
                <><RefreshCw className="w-4 h-4 mr-2" /> Start Update</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
