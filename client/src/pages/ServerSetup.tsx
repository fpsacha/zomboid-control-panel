import { useState, useEffect, useContext, useRef, useMemo } from 'react'
import { 
  Download, 
  Server,
  CheckCircle,
  Loader2,
  Terminal,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  Eye,
  EyeOff,
  Cpu,
  FolderOpen,
  Zap,
  Shield,
  Settings2,
  Plus,
  HardDrive,
  Play,
  Sparkles,
  RefreshCw,
  Copy,
  Check,
  Info,
  ArrowRight
} from 'lucide-react'
import { configApi, serverApi, serversApi } from '@/lib/api'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import { SocketContext } from '@/contexts/SocketContext'
import { Slider } from '@/components/ui/slider'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'

interface InstallLog {
  type: 'info' | 'success' | 'error' | 'command' | 'stdout' | 'stderr'
  message: string
  timestamp: Date
}

type SetupMode = 'select' | 'full' | 'quick'

// Generate a random password
function generatePassword(length = 12): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

// Format bytes to human readable size
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

export default function ServerSetup() {
  const [setupMode, setSetupMode] = useState<SetupMode>('select')
  const [currentStep, setCurrentStep] = useState(1)
  
  // Step 1: Prerequisites
  const [steamCmdPath, setSteamCmdPath] = useState('C:\\SteamCMD')
  const [hasSteamCmd, setHasSteamCmd] = useState(false)
  
  // Step 2: Server Config
  const [installPath, setInstallPath] = useState('C:\\PZServer')
  const [serverName, setServerName] = useState('myserver')
  const [branch, setBranch] = useState('public')
  const [availableBranches, setAvailableBranches] = useState<Array<{name: string, description: string, buildId?: string | null}>>([
    { name: 'public', description: 'Stable release (Build 42)' },
    { name: 'b41multiplayer', description: 'Build 41 Multiplayer' }
  ])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [useCustomDataPath, setUseCustomDataPath] = useState(false)
  const [zomboidDataPath, setZomboidDataPath] = useState('')
  const [rconPassword, setRconPassword] = useState('')
  const [rconPort, setRconPort] = useState(27015)
  const [showRconPassword, setShowRconPassword] = useState(false)
  const [copiedPassword, setCopiedPassword] = useState(false)
  
  // Step 3: Performance
  const [minMemory, setMinMemory] = useState(4)
  const [maxMemory, setMaxMemory] = useState(8)
  const [serverPort, setServerPort] = useState(16261)
  const [useUpnp, setUseUpnp] = useState(true)
  const [adminPassword, setAdminPassword] = useState('')
  const [showAdminPassword, setShowAdminPassword] = useState(false)
  const [useNoSteam, setUseNoSteam] = useState(false)
  const [useDebug, setUseDebug] = useState(false)
  const [systemRam, setSystemRam] = useState<{ totalGB: number; freeGB: number; recommendedMin: number; recommendedMax: number } | null>(null)
  const [detectingRam, setDetectingRam] = useState(false)
  
  // Installation state
  const [installing, setInstalling] = useState(false)
  const [logs, setLogs] = useState<InstallLog[]>([])
  const [installComplete, setInstallComplete] = useState(false)
  const [installProgress, setInstallProgress] = useState<{ percent: number; downloaded: string; total: string; status: string } | null>(null)
  
  // SteamCMD auto-download state
  const [downloadingSteamCmd, setDownloadingSteamCmd] = useState(false)
  const [steamCmdStatus, setSteamCmdStatus] = useState<string>('')
  
  const { toast } = useToast()
  const socket = useContext(SocketContext)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const [startingServer, setStartingServer] = useState(false)

  // Total steps based on mode
  const totalSteps = setupMode === 'quick' ? 3 : 4

  // Validation for each step
  const stepValidation = useMemo(() => {
    if (setupMode === 'quick') {
      return {
        1: installPath.length > 0,
        2: serverName.length > 0 && rconPassword.length >= 6,
        3: true,
      }
    }
    return {
      1: steamCmdPath.length > 0 && hasSteamCmd,
      2: installPath.length > 0 && serverName.length > 0,
      3: rconPassword.length >= 6,
      4: true,
    }
  }, [setupMode, steamCmdPath, hasSteamCmd, installPath, serverName, rconPassword])

  const canProceed = stepValidation[currentStep as keyof typeof stepValidation]

  // Generate random password on mount if empty
  useEffect(() => {
    if (!rconPassword) {
      setRconPassword(generatePassword(12))
    }
  }, [])

  // Auto-detect RAM on mount
  useEffect(() => {
    handleAutoDetectRam()
  }, [])

  // Load saved settings
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await configApi.getAppSettings()
        const settings = data.settings || {}
        if (settings.steamcmdPath) {
          setSteamCmdPath(settings.steamcmdPath)
          setHasSteamCmd(true)
        }
        if (settings.serverPath) setInstallPath(settings.serverPath)
        if (settings.serverName) setServerName(settings.serverName)
        if (settings.zomboidDataPath) {
          setZomboidDataPath(settings.zomboidDataPath)
          setUseCustomDataPath(true)
        }
        // Memory is stored in MB, convert to GB for display
        // Clamp to reasonable values (2-16 GB) to match slider range
        if (settings.minMemory) setMinMemory(Math.min(16, Math.max(2, Math.round(settings.minMemory / 1024) || 4)))
        if (settings.maxMemory) setMaxMemory(Math.min(16, Math.max(2, Math.round(settings.maxMemory / 1024) || 8)))
        if (settings.serverPort) setServerPort(settings.serverPort)
      } catch (error) {
        console.error('Failed to load settings:', error)
      }
    }
    loadSettings()
  }, [])

  // Fetch available Steam branches
  useEffect(() => {
    const fetchBranches = async () => {
      setLoadingBranches(true)
      try {
        const data = await serverApi.getBranches(steamCmdPath)
        if (data.branches && Array.isArray(data.branches)) {
          setAvailableBranches(data.branches)
          if (!data.branches.find((b: {name: string}) => b.name === branch)) {
            setBranch('public')
          }
        }
      } catch (error) {
        console.error('Failed to fetch branches:', error)
      } finally {
        setLoadingBranches(false)
      }
    }
    
    if (hasSteamCmd && steamCmdPath) {
      fetchBranches()
    }
  }, [hasSteamCmd, steamCmdPath])

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // Socket.IO events for installation
  useEffect(() => {
    if (!socket) return

    const handleInstallLog = (data: { type: 'stdout' | 'stderr'; text: string }) => {
      const text = data.text.trim()
      setLogs(prev => [...prev, { type: data.type, message: text, timestamp: new Date() }])
      
      // Parse SteamCMD progress: "Update state (0x61) downloading, progress: 50.00 (1234567890 / 2469135780)"
      const progressMatch = text.match(/progress:\s*([\d.]+)\s*\(([\d,]+)\s*\/\s*([\d,]+)\)/)
      if (progressMatch) {
        const percent = parseFloat(progressMatch[1])
        const downloaded = formatBytes(parseInt(progressMatch[2].replace(/,/g, '')))
        const total = formatBytes(parseInt(progressMatch[3].replace(/,/g, '')))
        setInstallProgress({ percent, downloaded, total, status: 'Downloading...' })
      }
      // Parse validation: "Validating files... 50%"
      const validateMatch = text.match(/[Vv]alidat\w*[^\d]*(\d+)%/)
      if (validateMatch) {
        setInstallProgress({ percent: parseInt(validateMatch[1]), downloaded: '', total: '', status: 'Validating files...' })
      }
      // Parse update state
      if (text.includes('Update state') && text.includes('verifying')) {
        setInstallProgress(prev => prev ? { ...prev, status: 'Verifying installation...' } : null)
      }
      if (text.includes('Success!') || text.includes('fully installed')) {
        setInstallProgress({ percent: 100, downloaded: '', total: '', status: 'Complete!' })
      }
    }

    const handleInstallComplete = async (data: { 
      success: boolean; 
      message: string; 
      installPath?: string;
      serverName?: string;
      zomboidDataPath?: string;
      serverConfigPath?: string;
      rconPort?: number;
      rconPassword?: string;
      serverPort?: number;
      minMemory?: number;
      maxMemory?: number;
    }) => {
      setInstalling(false)
      setInstallComplete(data.success)
      if (data.success) {
        setLogs(prev => [...prev, { type: 'success', message: data.message, timestamp: new Date() }])
        
        try {
          // Use data from server response which has computed paths
          await serversApi.create({
            name: data.serverName || serverName,
            serverName: data.serverName || serverName,
            installPath: data.installPath || installPath,
            zomboidDataPath: data.zomboidDataPath || null,
            serverConfigPath: data.serverConfigPath || null,
            rconHost: '127.0.0.1',
            rconPort: data.rconPort || rconPort,
            rconPassword: data.rconPassword || rconPassword,
            serverPort: data.serverPort || serverPort,
            minMemory: (data.minMemory || minMemory) * 1024,
            maxMemory: (data.maxMemory || maxMemory) * 1024,
            useNoSteam: useNoSteam,
            useDebug: useDebug,
          })
          setLogs(prev => [...prev, { type: 'success', message: 'Server registered in panel database', timestamp: new Date() }])
        } catch (error) {
          console.error('Failed to create server entry:', error)
          setLogs(prev => [...prev, { type: 'error', message: 'Warning: Failed to register server in panel.', timestamp: new Date() }])
        }
        
        toast({ title: 'Installation Complete', description: 'Server installed successfully' })
      } else {
        setLogs(prev => [...prev, { type: 'error', message: data.message, timestamp: new Date() }])
        toast({ title: 'Installation Failed', description: data.message, variant: 'destructive' })
      }
    }

    socket.on('install:log', handleInstallLog)
    socket.on('install:complete', handleInstallComplete)
    
    const handleSteamCmdStatus = (data: { status: string; message: string; path?: string }) => {
      setSteamCmdStatus(data.message)
      if (data.status === 'complete' && data.path) {
        setSteamCmdPath(data.path)
        setHasSteamCmd(true)
        setDownloadingSteamCmd(false)
        toast({ title: 'SteamCMD Ready', description: 'SteamCMD installed successfully!' })
      } else if (data.status === 'error') {
        setDownloadingSteamCmd(false)
        toast({ title: 'Error', description: data.message, variant: 'destructive' })
      }
    }
    
    const handleSteamCmdLog = (data: { type: string; text: string }) => {
      setSteamCmdStatus(data.text.trim())
    }
    
    socket.on('steamcmd:status', handleSteamCmdStatus)
    socket.on('steamcmd:log', handleSteamCmdLog)
    
    return () => {
      socket.off('install:log', handleInstallLog)
      socket.off('install:complete', handleInstallComplete)
      socket.off('steamcmd:status', handleSteamCmdStatus)
      socket.off('steamcmd:log', handleSteamCmdLog)
    }
  }, [socket, toast, serverName, installPath, zomboidDataPath, useCustomDataPath, rconPort, rconPassword, serverPort, minMemory, maxMemory, useNoSteam, useDebug])

  const addLog = (type: InstallLog['type'], message: string) => {
    setLogs(prev => [...prev, { type, message, timestamp: new Date() }])
  }

  const handleAutoDownloadSteamCmd = async () => {
    setDownloadingSteamCmd(true)
    setSteamCmdStatus('Starting download...')
    try {
      await serverApi.downloadSteamCmd(steamCmdPath)
    } catch (error) {
      setDownloadingSteamCmd(false)
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to start download', variant: 'destructive' })
    }
  }

  const handleBrowseFolder = async (setter: (path: string) => void, description: string, currentPath?: string) => {
    try {
      const result = await serverApi.browseFolder(currentPath, description)
      if (result.success && result.path) {
        setter(result.path)
      }
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to open folder browser', variant: 'destructive' })
    }
  }

  const handleAutoDetectRam = async () => {
    setDetectingRam(true)
    try {
      const response = await fetch('/api/debug/ram')
      const data = await response.json()
      if (response.ok) {
        setSystemRam({ 
          totalGB: data.totalGB, 
          freeGB: data.freeGB,
          recommendedMin: data.recommendedMin,
          recommendedMax: data.recommendedMax
        })
        setMinMemory(data.recommendedMin)
        setMaxMemory(data.recommendedMax)
      }
    } catch {
      // Silent fail - defaults are fine
    } finally {
      setDetectingRam(false)
    }
  }

  const handleCopyPassword = () => {
    navigator.clipboard.writeText(rconPassword)
    setCopiedPassword(true)
    toast({ title: 'Copied', description: 'Password copied to clipboard' })
    setTimeout(() => setCopiedPassword(false), 2000)
  }

  const handleRegeneratePassword = () => {
    setRconPassword(generatePassword(12))
    toast({ title: 'Generated', description: 'New password generated' })
  }

  const handleInstall = async () => {
    if (!adminPassword) {
      toast({ title: 'Error', description: 'Admin password is required for new server installations', variant: 'destructive' })
      return
    }
    setInstalling(true)
    setLogs([])
    setInstallProgress(null)
    addLog('info', 'Starting installation...')

    try {
      const response = await fetch('/api/server/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steamcmdPath: steamCmdPath,
          installPath,
          serverName,
          branch,
          zomboidDataPath: useCustomDataPath ? zomboidDataPath : null,
          minMemory,
          maxMemory,
          adminPassword: adminPassword || null,
          serverPort,
          useUpnp,
          useNoSteam,
          useDebug,
          rconPassword,
          rconPort
        })
      })

      const data = await response.json()
      if (!response.ok) {
        addLog('error', data.error)
        setInstalling(false)
        toast({ title: 'Error', description: data.error, variant: 'destructive' })
      }
    } catch (error) {
      addLog('error', `Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
      setInstalling(false)
    }
  }

  const handleQuickSetup = async () => {
    if (!adminPassword) {
      toast({ title: 'Error', description: 'Admin password is required for new server setup', variant: 'destructive' })
      return
    }
    setInstalling(true)
    setLogs([])
    addLog('info', 'Creating server configuration...')

    try {
      const response = await fetch('/api/server/quick-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installPath,
          serverName,
          zomboidDataPath: useCustomDataPath ? zomboidDataPath : null,
          minMemory,
          maxMemory,
          adminPassword: adminPassword || null,
          serverPort,
          useUpnp,
          useNoSteam,
          useDebug,
          rconPassword,
          rconPort
        })
      })

      const data = await response.json()
      if (response.ok) {
        addLog('success', 'Server configuration created successfully!')
        
        try {
          // Use data from server response which has computed paths
          await serversApi.create({
            name: data.serverName || serverName,
            serverName: data.serverName || serverName,
            installPath: data.installPath || installPath,
            zomboidDataPath: data.zomboidDataPath || null,
            serverConfigPath: data.serverConfigPath || null,
            rconHost: '127.0.0.1',
            rconPort: data.rconPort || rconPort,
            rconPassword: data.rconPassword || rconPassword,
            serverPort: data.serverPort || serverPort,
            minMemory: (data.minMemory || minMemory) * 1024,
            maxMemory: (data.maxMemory || maxMemory) * 1024,
            useNoSteam: useNoSteam,
            useDebug: useDebug,
          })
          addLog('success', 'Server registered in panel database')
        } catch (error) {
          console.error('Failed to create server entry:', error)
          addLog('error', 'Warning: Failed to register server in panel.')
        }
        
        setInstallComplete(true)
        toast({ title: 'Success', description: 'Server configuration created' })
      } else {
        addLog('error', data.error)
        toast({ title: 'Error', description: data.error, variant: 'destructive' })
      }
    } catch (error) {
      addLog('error', `Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setInstalling(false)
    }
  }

  const handleSaveSteamCmdPath = async () => {
    try {
      await configApi.updateAppSettings({ steamcmdPath: steamCmdPath })
      setHasSteamCmd(true)
      toast({ title: 'Saved', description: 'SteamCMD path saved' })
    } catch {
      toast({ title: 'Error', description: 'Failed to save path', variant: 'destructive' })
    }
  }

  // Mode selection screen
  if (setupMode === 'select') {
    return (
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold">Server Setup</h1>
          <p className="text-muted-foreground text-lg">Get your Project Zomboid server up and running</p>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Full Install Card */}
          <Card 
            className="cursor-pointer transition-all hover:border-primary hover:shadow-lg group relative overflow-hidden"
            onClick={() => { setSetupMode('full'); setCurrentStep(1) }}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <CardHeader className="pb-4">
              <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/20 transition-colors">
                <Download className="w-7 h-7 text-primary" />
              </div>
              <CardTitle className="text-xl">Fresh Install</CardTitle>
              <CardDescription>
                Download and set up a new server from scratch
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span>Downloads server files via SteamCMD (~3GB)</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span>Choose game version branch</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span>Auto-configure everything</span>
                </div>
              </div>
              <div className="pt-2">
                <Badge variant="secondary" className="text-xs">Recommended for first-time setup</Badge>
              </div>
            </CardContent>
          </Card>

          {/* Quick Setup Card */}
          <Card 
            className="cursor-pointer transition-all hover:border-green-500 hover:shadow-lg group relative overflow-hidden"
            onClick={() => { setSetupMode('quick'); setCurrentStep(1) }}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-green-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <CardHeader className="pb-4">
              <div className="w-14 h-14 rounded-2xl bg-green-500/10 flex items-center justify-center mb-4 group-hover:bg-green-500/20 transition-colors">
                <Plus className="w-7 h-7 text-green-500" />
              </div>
              <CardTitle className="text-xl">Use Existing Files</CardTitle>
              <CardDescription>
                Create a new server from files you already have
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span>No download required</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span>Point to existing PZ server folder</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span>Quick 2-step setup</span>
                </div>
              </div>
              <div className="pt-2">
                <Badge variant="outline" className="text-xs">Already have server files?</Badge>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Quick Tips */}
        <Card className="bg-muted/50">
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                <Info className="w-5 h-5 text-blue-500" />
              </div>
              <div className="space-y-1">
                <p className="font-medium">Not sure which to choose?</p>
                <p className="text-sm text-muted-foreground">
                  If you've never set up a Project Zomboid server before, choose <strong>Fresh Install</strong>. 
                  It will download everything you need automatically.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Step indicator
  const renderStepIndicator = () => {
    const steps = setupMode === 'quick' 
      ? [
          { id: 1, label: 'Location', icon: HardDrive },
          { id: 2, label: 'Configure', icon: Settings2 },
          { id: 3, label: 'Create', icon: Plus },
        ]
      : [
          { id: 1, label: 'SteamCMD', icon: Download },
          { id: 2, label: 'Server', icon: Server },
          { id: 3, label: 'Settings', icon: Settings2 },
          { id: 4, label: 'Install', icon: Zap },
        ]

    return (
      <div className="flex items-center justify-center mb-8">
        <div className="flex items-center gap-1">
          {steps.map((step, index) => {
            const Icon = step.icon
            const isActive = currentStep === step.id
            const isComplete = currentStep > step.id
            const isClickable = step.id <= currentStep || stepValidation[step.id as keyof typeof stepValidation]
            
            return (
              <div key={step.id} className="flex items-center">
                <button
                  onClick={() => isClickable && setCurrentStep(step.id)}
                  disabled={!isClickable}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2.5 rounded-full transition-all",
                    isActive && "bg-primary text-primary-foreground shadow-md",
                    !isActive && isComplete && "bg-green-500/20 text-green-600 dark:text-green-400",
                    !isActive && !isComplete && "bg-muted text-muted-foreground",
                    isClickable && !isActive && "hover:bg-muted/80 cursor-pointer"
                  )}
                >
                  {isComplete ? (
                    <CheckCircle className="w-4 h-4" />
                  ) : (
                    <Icon className="w-4 h-4" />
                  )}
                  <span className="text-sm font-medium">{step.label}</span>
                </button>
                {index < steps.length - 1 && (
                  <ArrowRight className={cn(
                    "w-4 h-4 mx-2",
                    isComplete ? "text-green-500" : "text-muted-foreground/50"
                  )} />
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Full Install Step 1: SteamCMD
  const renderFullStep1 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Set Up SteamCMD</h2>
        <p className="text-muted-foreground">
          SteamCMD downloads the Project Zomboid server files from Steam
        </p>
      </div>

      {!hasSteamCmd ? (
        <div className="space-y-6">
          {/* One-Click Setup */}
          <Card className="border-primary/50 bg-primary/5">
            <CardContent className="pt-6">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
                  <Sparkles className="w-6 h-6 text-primary" />
                </div>
                <div className="flex-1 space-y-4">
                  <div>
                    <h3 className="font-semibold text-lg">One-Click Setup</h3>
                    <p className="text-sm text-muted-foreground">
                      We'll download and configure SteamCMD automatically
                    </p>
                  </div>
                  
                  <div className="flex gap-2 items-center">
                    <Input
                      value={steamCmdPath}
                      onChange={(e) => setSteamCmdPath(e.target.value)}
                      placeholder="C:\SteamCMD"
                      className="font-mono flex-1"
                      disabled={downloadingSteamCmd}
                    />
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => handleBrowseFolder(setSteamCmdPath, 'Select SteamCMD folder', steamCmdPath)}
                            disabled={downloadingSteamCmd}
                          >
                            <FolderOpen className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Browse folder</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  
                  <Button 
                    onClick={handleAutoDownloadSteamCmd}
                    disabled={downloadingSteamCmd}
                    className="w-full"
                    size="lg"
                  >
                    {downloadingSteamCmd ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        {steamCmdStatus || 'Installing...'}
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4 mr-2" />
                        Install SteamCMD Automatically
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Manual Setup Accordion */}
          <Accordion type="single" collapsible className="border rounded-lg">
            <AccordionItem value="manual" className="border-0">
              <AccordionTrigger className="px-4 hover:no-underline">
                <div className="flex items-center gap-2">
                  <Settings2 className="w-4 h-4" />
                  <span>Already have SteamCMD? Configure manually</span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4">
                <div className="space-y-4">
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 text-sm">
                    <p className="font-medium text-amber-600 dark:text-amber-400">Manual Setup Instructions:</p>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground mt-2">
                      <li>Download SteamCMD from Valve</li>
                      <li>Extract to a folder (e.g., <code className="bg-muted px-1 rounded">C:\SteamCMD</code>)</li>
                      <li>Run <code className="bg-muted px-1 rounded">steamcmd.exe</code> once to update</li>
                    </ol>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="mt-3"
                      onClick={() => window.open('https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip', '_blank')}
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download SteamCMD
                      <ExternalLink className="w-3 h-3 ml-2" />
                    </Button>
                  </div>

                  <div className="flex gap-2">
                    <Input
                      value={steamCmdPath}
                      onChange={(e) => setSteamCmdPath(e.target.value)}
                      placeholder="C:\SteamCMD"
                      className="font-mono flex-1"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => handleBrowseFolder(setSteamCmdPath, 'Select SteamCMD folder', steamCmdPath)}
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                    <Button onClick={handleSaveSteamCmdPath}>
                      Set Path
                    </Button>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      ) : (
        <Card className="border-green-500/50 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-green-500/20 flex items-center justify-center">
                <CheckCircle className="w-6 h-6 text-green-500" />
              </div>
              <div className="flex-1">
                <p className="font-semibold">SteamCMD Ready</p>
                <p className="text-sm text-muted-foreground font-mono">{steamCmdPath}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setHasSteamCmd(false)}>
                Change
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )

  // Full Install Step 2: Server Location & Name
  const renderFullStep2 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Server Details</h2>
        <p className="text-muted-foreground">
          Where to install and what to call your server
        </p>
      </div>

      <div className="grid gap-6">
        {/* Installation Path */}
        <div className="space-y-2">
          <Label className="text-base">Installation Folder</Label>
          <div className="flex gap-2">
            <Input
              value={installPath}
              onChange={(e) => setInstallPath(e.target.value)}
              placeholder="C:\PZServer"
              className="font-mono flex-1"
            />
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => handleBrowseFolder(setInstallPath, 'Select server folder', installPath)}
                  >
                    <FolderOpen className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Browse folder</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="text-xs text-muted-foreground">Server files will be downloaded here (~3GB)</p>
        </div>

        {/* Server Name */}
        <div className="space-y-2">
          <Label className="text-base">Server Name</Label>
          <Input
            value={serverName}
            onChange={(e) => setServerName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
            placeholder="myserver"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Alphanumeric and underscores only. Used for config files.
          </p>
        </div>

        {/* Branch Selection */}
        <div className="space-y-2">
          <Label className="text-base">Game Version</Label>
          <Select value={branch} onValueChange={setBranch} disabled={loadingBranches}>
            <SelectTrigger>
              <SelectValue placeholder={loadingBranches ? "Loading..." : "Select version"} />
            </SelectTrigger>
            <SelectContent>
              {availableBranches.map((b) => (
                <SelectItem key={b.name} value={b.name}>
                  <div className="flex flex-col">
                    <span>{b.name === 'public' ? 'Build 42 (Stable)' : b.description || b.name}</span>
                    {b.buildId && (
                      <span className="text-xs text-muted-foreground">Build: {b.buildId}</span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Custom Data Path - Collapsed by default */}
        <Accordion type="single" collapsible className="border rounded-lg">
          <AccordionItem value="datapath" className="border-0">
            <AccordionTrigger className="px-4 hover:no-underline">
              <div className="flex items-center gap-2 text-sm">
                <FolderOpen className="w-4 h-4" />
                <span>Custom config location</span>
                {useCustomDataPath && zomboidDataPath && (
                  <Badge variant="secondary" className="ml-2">Set</Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4">
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  By default, server config goes to <code className="bg-muted px-1 rounded">%USERPROFILE%\Zomboid</code>
                </p>
                <div className="flex items-center gap-3">
                  <Switch checked={useCustomDataPath} onCheckedChange={setUseCustomDataPath} />
                  <Label>Use custom location</Label>
                </div>
                {useCustomDataPath && (
                  <div className="flex gap-2">
                    <Input
                      value={zomboidDataPath}
                      onChange={(e) => setZomboidDataPath(e.target.value)}
                      placeholder="D:\PZServerData"
                      className="font-mono flex-1"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => handleBrowseFolder(setZomboidDataPath, 'Select config folder', zomboidDataPath)}
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  )

  // Full Install Step 3: RCON & Performance
  const renderFullStep3 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Server Settings</h2>
        <p className="text-muted-foreground">
          RCON connection and performance options
        </p>
      </div>

      {/* RCON Section - Critical */}
      <Card className="border-primary/50 bg-primary/5">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">Remote Control (RCON)</CardTitle>
            <Badge className="ml-auto">Required</Badge>
          </div>
          <CardDescription>
            RCON allows this panel to control your server
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>RCON Password</Label>
              <div className="flex gap-1">
                <div className="relative flex-1">
                  <Input
                    type={showRconPassword ? 'text' : 'password'}
                    value={rconPassword}
                    onChange={(e) => setRconPassword(e.target.value)}
                    className="pr-10 font-mono"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1 h-7 w-7 p-0"
                    onClick={() => setShowRconPassword(!showRconPassword)}
                  >
                    {showRconPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="icon" onClick={handleCopyPassword}>
                        {copiedPassword ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy password</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="icon" onClick={handleRegeneratePassword}>
                        <RefreshCw className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Generate new password</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {rconPassword.length > 0 && rconPassword.length < 6 && (
                <p className="text-xs text-destructive">Minimum 6 characters</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>RCON Port</Label>
              <Input
                type="number"
                value={rconPort}
                onChange={(e) => setRconPort(parseInt(e.target.value) || 27015)}
                className="font-mono"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Memory Settings */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-5 h-5" />
              <CardTitle className="text-lg">Memory Allocation</CardTitle>
            </div>
            {detectingRam ? (
              <Badge variant="outline" className="animate-pulse">
                Detecting RAM...
              </Badge>
            ) : systemRam && (
              <Badge variant="outline">
                {systemRam.totalGB}GB RAM detected
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <div className="flex justify-between">
                <Label>Minimum RAM</Label>
                <span className="font-mono font-medium">{minMemory}GB</span>
              </div>
              <Slider
                value={[minMemory]}
                onValueChange={([val]) => {
                  setMinMemory(val)
                  if (val > maxMemory) setMaxMemory(val)
                }}
                min={2}
                max={16}
                step={1}
              />
            </div>

            <div className="space-y-3">
              <div className="flex justify-between">
                <Label>Maximum RAM</Label>
                <span className="font-mono font-medium">{maxMemory}GB</span>
              </div>
              <Slider
                value={[maxMemory]}
                onValueChange={([val]) => {
                  setMaxMemory(val)
                  if (val < minMemory) setMinMemory(val)
                }}
                min={2}
                max={16}
                step={1}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Advanced Options - Collapsed */}
      <Accordion type="single" collapsible className="border rounded-lg">
        <AccordionItem value="advanced" className="border-0">
          <AccordionTrigger className="px-4 hover:no-underline">
            <div className="flex items-center gap-2">
              <Settings2 className="w-4 h-4" />
              <span>Advanced Options</span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Game Port</Label>
                <Input
                  type="number"
                  value={serverPort}
                  onChange={(e) => setServerPort(parseInt(e.target.value) || 16261)}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">Default: 16261</p>
              </div>

              <div className="space-y-2">
                <Label>Admin Password <span className="text-red-500">*</span></Label>
                <div className="relative">
                  <Input
                    type={showAdminPassword ? 'text' : 'password'}
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    placeholder="Required for first run"
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1 h-7 w-7 p-0"
                    onClick={() => setShowAdminPassword(!showAdminPassword)}
                  >
                    {showAdminPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">UPnP</p>
                  <p className="text-xs text-muted-foreground">Auto port forward</p>
                </div>
                <Switch checked={useUpnp} onCheckedChange={setUseUpnp} />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">No Steam</p>
                  <p className="text-xs text-muted-foreground">For GOG users</p>
                </div>
                <Switch checked={useNoSteam} onCheckedChange={setUseNoSteam} />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">Debug</p>
                  <p className="text-xs text-muted-foreground">Verbose logs</p>
                </div>
                <Switch checked={useDebug} onCheckedChange={setUseDebug} />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )

  // Full Install Step 4: Review & Install
  const renderFullStep4 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Ready to Install</h2>
        <p className="text-muted-foreground">
          Review your settings and start the installation
        </p>
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Installation Path</span>
              <span className="font-mono text-right max-w-[300px] truncate">{installPath}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Server Name</span>
              <span className="font-mono">{serverName}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Game Version</span>
              <span>{branch === 'public' ? 'Build 42 (Stable)' : branch}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Memory</span>
              <span className="font-mono">{minMemory}GB - {maxMemory}GB</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Game Port</span>
              <span className="font-mono">{serverPort}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">RCON Port</span>
              <span className="font-mono">{rconPort}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Port Info */}
      <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 text-sm">
        <p className="font-medium flex items-center gap-2">
          <Info className="w-4 h-4 text-blue-500" />
          Firewall / Port Forwarding
        </p>
        <p className="text-muted-foreground mt-1">
          You may need to open these ports:
        </p>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li>• <code className="bg-muted px-1 rounded">{serverPort}</code> UDP - Game traffic</li>
          <li>• <code className="bg-muted px-1 rounded">{serverPort + 1}</code> UDP - Direct connect</li>
        </ul>
      </div>

      {/* Install Button */}
      <Button 
        onClick={handleInstall} 
        disabled={installing}
        className="w-full"
        size="lg"
      >
        {installing ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Installing... Check log below
          </>
        ) : (
          <>
            <Download className="w-4 h-4 mr-2" />
            Install Project Zomboid Server
          </>
        )}
      </Button>

      {/* Installation Progress Bar */}
      {installing && installProgress && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{installProgress.status}</span>
            <span className="font-mono">
              {installProgress.percent.toFixed(0)}%
              {installProgress.downloaded && installProgress.total && (
                <span className="text-muted-foreground ml-2">
                  ({installProgress.downloaded} / {installProgress.total})
                </span>
              )}
            </span>
          </div>
          <Progress value={installProgress.percent} className="h-2" />
        </div>
      )}

      {/* Installation Log */}
      {logs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4" />
            <span className="text-sm font-medium">Installation Log</span>
          </div>
          <ScrollArea className="h-[200px] bg-black rounded-lg p-3">
            <div className="font-mono text-xs space-y-0.5">
              {logs.map((log, i) => (
                <div key={i} className={cn(
                  log.type === 'error' || log.type === 'stderr' ? 'text-red-400' :
                  log.type === 'success' ? 'text-green-400' :
                  log.type === 'command' ? 'text-blue-400' :
                  'text-gray-300'
                )}>
                  {log.message}
                </div>
              ))}
              {installing && <div className="text-gray-400 animate-pulse">...</div>}
              <div ref={logsEndRef} />
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Post-install */}
      {installComplete && (
        <Card className="border-green-500/50 bg-green-500/5">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center gap-2 text-green-500">
              <CheckCircle className="w-5 h-5" />
              <span className="font-medium">Installation Complete!</span>
            </div>
            
            {/* First-run setup notice */}
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 text-sm">
              <p className="font-medium flex items-center gap-2 text-amber-500">
                <Info className="w-4 h-4" />
                First Run Required
              </p>
              <p className="text-muted-foreground mt-1">
                The server needs to start once to generate its configuration files. 
                It will create the server settings, world data, and admin credentials.
                This first startup may take a minute.
              </p>
            </div>
            
            <div className="flex gap-3">
              <Button 
                onClick={async () => {
                  setStartingServer(true)
                  try {
                    await serverApi.start()
                    toast({ title: 'Server Starting', description: 'Redirecting to dashboard...' })
                    setTimeout(() => navigate('/'), 2000)
                  } catch (error) {
                    toast({ 
                      title: 'Failed to start', 
                      description: error instanceof Error ? error.message : 'Unknown error',
                      variant: 'destructive'
                    })
                  } finally {
                    setStartingServer(false)
                  }
                }}
                disabled={startingServer}
                className="flex-1"
              >
                {startingServer ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Starting...</>
                ) : (
                  <><Play className="w-4 h-4 mr-2" /> Start Server Now</>
                )}
              </Button>
              <Button variant="outline" onClick={() => navigate('/')}>
                Go to Dashboard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )

  // Quick Setup Step 1: Select Files
  const renderQuickStep1 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Select Server Files</h2>
        <p className="text-muted-foreground">
          Point to your existing Project Zomboid server installation
        </p>
      </div>

      <Card className="bg-blue-500/5 border-blue-500/30">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
              <HardDrive className="w-5 h-5 text-blue-500" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">Using existing files</p>
              <p className="text-sm text-muted-foreground">
                The folder should contain <code className="bg-muted px-1 rounded">StartServer64.bat</code> and the <code className="bg-muted px-1 rounded">java</code> folder.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <Label className="text-base">Server Files Location</Label>
        <div className="flex gap-2">
          <Input
            value={installPath}
            onChange={(e) => setInstallPath(e.target.value)}
            placeholder="D:\PZServer"
            className="font-mono flex-1"
          />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => handleBrowseFolder(setInstallPath, 'Select PZ server folder', installPath)}
                >
                  <FolderOpen className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Browse folder</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <p className="text-xs text-muted-foreground">
          Folder containing your Project Zomboid dedicated server files
        </p>
      </div>
    </div>
  )

  // Quick Setup Step 2: Configure
  const renderQuickStep2 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Configure Server</h2>
        <p className="text-muted-foreground">
          Set up your new server instance
        </p>
      </div>

      <div className="grid gap-6">
        {/* Server Name */}
        <div className="space-y-2">
          <Label className="text-base">Server Name</Label>
          <Input
            value={serverName}
            onChange={(e) => setServerName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
            placeholder="myserver"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Each server needs a unique name. Creates separate config files.
          </p>
        </div>

        {/* RCON - Critical */}
        <Card className="border-primary/50 bg-primary/5">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <CardTitle className="text-lg">Remote Control (RCON)</CardTitle>
              <Badge className="ml-auto">Required</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>RCON Password</Label>
                <div className="flex gap-1">
                  <div className="relative flex-1">
                    <Input
                      type={showRconPassword ? 'text' : 'password'}
                      value={rconPassword}
                      onChange={(e) => setRconPassword(e.target.value)}
                      className="pr-10 font-mono"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1 h-7 w-7 p-0"
                      onClick={() => setShowRconPassword(!showRconPassword)}
                    >
                      {showRconPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="icon" onClick={handleCopyPassword}>
                          {copiedPassword ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Copy password</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="icon" onClick={handleRegeneratePassword}>
                          <RefreshCw className="w-4 h-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Generate new</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                {rconPassword.length > 0 && rconPassword.length < 6 && (
                  <p className="text-xs text-destructive">Minimum 6 characters</p>
                )}
              </div>

              <div className="space-y-2">
                <Label>RCON Port</Label>
                <Input
                  type="number"
                  value={rconPort}
                  onChange={(e) => setRconPort(parseInt(e.target.value) || 27015)}
                  className="font-mono"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Memory */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-5 h-5" />
                <CardTitle className="text-lg">Memory</CardTitle>
              </div>
              {detectingRam ? (
                <Badge variant="outline" className="animate-pulse">Detecting...</Badge>
              ) : systemRam && (
                <Badge variant="outline">{systemRam.totalGB}GB detected</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-3">
                <div className="flex justify-between">
                  <Label>Min RAM</Label>
                  <span className="font-mono">{minMemory}GB</span>
                </div>
                <Slider
                  value={[minMemory]}
                  onValueChange={([val]) => {
                    setMinMemory(val)
                    if (val > maxMemory) setMaxMemory(val)
                  }}
                  min={2}
                  max={16}
                  step={1}
                />
              </div>

              <div className="space-y-3">
                <div className="flex justify-between">
                  <Label>Max RAM</Label>
                  <span className="font-mono">{maxMemory}GB</span>
                </div>
                <Slider
                  value={[maxMemory]}
                  onValueChange={([val]) => {
                    setMaxMemory(val)
                    if (val < minMemory) setMinMemory(val)
                  }}
                  min={2}
                  max={16}
                  step={1}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Advanced Options */}
        <Accordion type="single" collapsible className="border rounded-lg">
          <AccordionItem value="advanced" className="border-0">
            <AccordionTrigger className="px-4 hover:no-underline">
              <div className="flex items-center gap-2">
                <Settings2 className="w-4 h-4" />
                <span>Advanced Options</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4 space-y-4">
              <div className="flex items-center gap-3">
                <Switch checked={useCustomDataPath} onCheckedChange={setUseCustomDataPath} />
                <Label>Custom config location</Label>
              </div>
              {useCustomDataPath && (
                <div className="flex gap-2">
                  <Input
                    value={zomboidDataPath}
                    onChange={(e) => setZomboidDataPath(e.target.value)}
                    placeholder="D:\PZServerData"
                    className="font-mono flex-1"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => handleBrowseFolder(setZomboidDataPath, 'Select config folder', zomboidDataPath)}
                  >
                    <FolderOpen className="w-4 h-4" />
                  </Button>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Game Port</Label>
                  <Input
                    type="number"
                    value={serverPort}
                    onChange={(e) => setServerPort(parseInt(e.target.value) || 16261)}
                    className="font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Admin Password <span className="text-red-500">*</span></Label>
                  <Input
                    type="password"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    placeholder="Required for first run"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <Label className="text-sm">UPnP</Label>
                  <Switch checked={useUpnp} onCheckedChange={setUseUpnp} />
                </div>
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <Label className="text-sm">No Steam</Label>
                  <Switch checked={useNoSteam} onCheckedChange={setUseNoSteam} />
                </div>
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <Label className="text-sm">Debug</Label>
                  <Switch checked={useDebug} onCheckedChange={setUseDebug} />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  )

  // Quick Setup Step 3: Create
  const renderQuickStep3 = () => (
    <div className="space-y-6">
      <div className="text-center space-y-2 pb-6 border-b">
        <h2 className="text-2xl font-semibold">Ready to Create</h2>
        <p className="text-muted-foreground">
          Review and create your server configuration
        </p>
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 text-sm">
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Server Files</span>
              <span className="font-mono text-right max-w-[300px] truncate">{installPath}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Server Name</span>
              <span className="font-mono">{serverName}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Memory</span>
              <span className="font-mono">{minMemory}GB - {maxMemory}GB</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">Game Port</span>
              <span className="font-mono">{serverPort}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-muted-foreground">RCON Port</span>
              <span className="font-mono">{rconPort}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Create Button */}
      <Button 
        onClick={handleQuickSetup} 
        disabled={installing}
        className="w-full"
        size="lg"
      >
        {installing ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Creating...
          </>
        ) : (
          <>
            <Plus className="w-4 h-4 mr-2" />
            Create Server Configuration
          </>
        )}
      </Button>

      {/* Log */}
      {logs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4" />
            <span className="text-sm font-medium">Setup Log</span>
          </div>
          <ScrollArea className="h-[150px] bg-black rounded-lg p-3">
            <div className="font-mono text-xs space-y-0.5">
              {logs.map((log, i) => (
                <div key={i} className={cn(
                  log.type === 'error' ? 'text-red-400' :
                  log.type === 'success' ? 'text-green-400' :
                  'text-gray-300'
                )}>
                  {log.message}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Post-create */}
      {installComplete && (
        <Card className="border-green-500/50 bg-green-500/5">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center gap-2 text-green-500">
              <CheckCircle className="w-5 h-5" />
              <span className="font-medium">Server Created!</span>
            </div>
            
            <div className="flex gap-3">
              <Button 
                onClick={async () => {
                  setStartingServer(true)
                  try {
                    await serverApi.start()
                    toast({ title: 'Server Starting', description: 'Redirecting to dashboard...' })
                    setTimeout(() => navigate('/'), 2000)
                  } catch (error) {
                    toast({ 
                      title: 'Failed to start', 
                      description: error instanceof Error ? error.message : 'Unknown error',
                      variant: 'destructive'
                    })
                  } finally {
                    setStartingServer(false)
                  }
                }}
                disabled={startingServer}
                className="flex-1"
              >
                {startingServer ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Starting...</>
                ) : (
                  <><Play className="w-4 h-4 mr-2" /> Start Server Now</>
                )}
              </Button>
              <Button variant="outline" onClick={() => navigate('/')}>
                Go to Dashboard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )

  // Render current step content
  const renderStepContent = () => {
    if (setupMode === 'quick') {
      switch (currentStep) {
        case 1: return renderQuickStep1()
        case 2: return renderQuickStep2()
        case 3: return renderQuickStep3()
      }
    } else {
      switch (currentStep) {
        case 1: return renderFullStep1()
        case 2: return renderFullStep2()
        case 3: return renderFullStep3()
        case 4: return renderFullStep4()
      }
    }
  }

  const isLastStep = currentStep === totalSteps

  return (
    <div className="max-w-3xl mx-auto space-y-6 page-transition">
      {/* Header */}
      <div className="text-center">
        <h1 className="text-3xl font-bold">
          {setupMode === 'quick' ? 'Quick Setup' : 'Fresh Install'}
        </h1>
        <p className="text-muted-foreground">
          {setupMode === 'quick' 
            ? 'Create a new server from existing files' 
            : 'Download and set up a new server'}
        </p>
      </div>

      {/* Step Indicator */}
      {renderStepIndicator()}

      {/* Main Content Card */}
      <Card>
        <CardContent className="pt-6">
          {renderStepContent()}
        </CardContent>
      </Card>

      {/* Navigation */}
      {!isLastStep && (
        <div className="flex justify-between">
          <Button
            variant="outline"
            onClick={() => {
              if (currentStep === 1) {
                setSetupMode('select')
              } else {
                setCurrentStep(s => s - 1)
              }
            }}
          >
            <ChevronLeft className="w-4 h-4 mr-2" />
            {currentStep === 1 ? 'Change Mode' : 'Back'}
          </Button>
          
          <Button
            onClick={() => setCurrentStep(s => s + 1)}
            disabled={!canProceed}
          >
            Continue
            <ChevronRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      )}

      {isLastStep && !installing && !installComplete && (
        <div className="flex justify-start">
          <Button variant="outline" onClick={() => setCurrentStep(s => s - 1)}>
            <ChevronLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
        </div>
      )}
    </div>
  )
}
