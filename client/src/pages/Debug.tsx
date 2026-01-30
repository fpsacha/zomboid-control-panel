import { useState, useEffect, useContext, useRef, useMemo, useCallback } from 'react'
import { 
  Bug, 
  RefreshCw, 
  Trash2, 
  Download,
  Terminal,
  AlertCircle,
  Info,
  AlertTriangle,
  CheckCircle,
  Pause,
  Play,
  FolderOpen,
  Save,
  Loader2,
  Search,
  X,
  FileText,
  Activity,
  Clock,
  Copy,
  ChevronDown,
  ChevronRight,
  Wifi,
  WifiOff,
  Server,
  Database,
  Settings,
  Zap,
  TrendingUp
} from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, AreaChart, Area } from 'recharts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { useToast } from '@/components/ui/use-toast'
import { SocketContext } from '@/contexts/SocketContext'

interface LogEntry {
  id: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  timestamp: Date
  source?: string
}

interface SystemInfo {
  nodeVersion: string
  platform: string
  uptime: number
  memoryUsage: {
    heapUsed: number
    heapTotal: number
    rss: number
  }
  dbPath: string
  logsPath: string
  dataDir: string
  pathsConfigurable: boolean
}

interface HealthStatus {
  status: 'ok' | 'error'
  timestamp: string
  services: {
    rcon: { connected: boolean; host: string }
    server: { running: boolean }
    modChecker: { running: boolean; interval: number }
  }
  memory: {
    heapUsed: number
    heapTotal: number
    rss: number
    external: number
  }
  uptime: number
}

interface LogFile {
  name: string
  size: number
  modified: string
}

interface PerformanceSnapshot {
  id: number
  timestamp: string
  memoryUsed: number
  memoryTotal: number
  cpuUsage: number
  playerCount: number
  serverRunning: boolean
  // Computed fields added by frontend
  memoryMB?: number
  cpuLoad?: number
  time?: string
}

interface CrashLog {
  name: string
  path: string
  size: number
  modified: string
}

type TimeFormat = 'relative' | 'time' | 'datetime'

export default function Debug() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null)
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null)
  const [logFiles, setLogFiles] = useState<LogFile[]>([])
  const [performanceHistory, setPerformanceHistory] = useState<PerformanceSnapshot[]>([])
  const [crashLogs, setCrashLogs] = useState<CrashLog[]>([])
  const [selectedCrashLog, setSelectedCrashLog] = useState<string | null>(null)
  const [crashLogContent, setCrashLogContent] = useState<string>('')
  const [loadingCrashLog, setLoadingCrashLog] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [paused, setPaused] = useState(false)
  const [levelFilter, setLevelFilter] = useState<'all' | 'info' | 'warn' | 'error' | 'debug'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [timeFormat, setTimeFormat] = useState<TimeFormat>('time')
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())
  const logsEndRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  const socket = useContext(SocketContext)
  
  // Path editing state
  const [editingPaths, setEditingPaths] = useState(false)
  const [newDataDir, setNewDataDir] = useState('')
  const [newLogsDir, setNewLogsDir] = useState('')
  const [moveFiles, setMoveFiles] = useState(true)
  const [savingPaths, setSavingPaths] = useState(false)

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F or Cmd+F to focus search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
      // Escape to clear search
      if (e.key === 'Escape' && searchQuery) {
        setSearchQuery('')
        searchInputRef.current?.blur()
      }
      // Space to toggle pause (when not in input)
      if (e.key === ' ' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        setPaused(p => !p)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [searchQuery])

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && !paused) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoScroll, paused])

  // Fetch system info
  const fetchSystemInfo = async () => {
    try {
      const res = await fetch('/api/debug/system')
      const data = await res.json()
      setSystemInfo(data)
    } catch (error) {
      console.error('Failed to fetch system info:', error)
    }
  }

  // Fetch health status
  const fetchHealthStatus = async () => {
    try {
      const res = await fetch('/api/debug/health')
      const data = await res.json()
      setHealthStatus(data)
    } catch (error) {
      console.error('Failed to fetch health status:', error)
    }
  }

  // Fetch log files list
  const fetchLogFiles = async () => {
    try {
      const res = await fetch('/api/debug/logs/files')
      const data = await res.json()
      if (data.files) {
        setLogFiles(data.files)
      }
    } catch {
      // Endpoint may not exist yet
    }
  }
  
  const fetchPerformanceHistory = async () => {
    try {
      const res = await fetch('/api/debug/performance-history?limit=60')
      const data = await res.json()
      if (data.history) {
        setPerformanceHistory(data.history.map((h: PerformanceSnapshot) => ({
          ...h,
          memoryMB: Math.round(h.memoryUsed / (1024 * 1024)),
          cpuLoad: h.cpuUsage,
          time: new Date(h.timestamp).toLocaleTimeString()
        })))
      }
    } catch {
      // Endpoint may not exist yet
    }
  }

  const fetchCrashLogs = async () => {
    try {
      const res = await fetch('/api/debug/crash-logs')
      const data = await res.json()
      if (data.crashLogs) {
        setCrashLogs(data.crashLogs)
      }
    } catch {
      // Endpoint may not exist yet
    }
  }

  const loadCrashLogContent = async (filename: string) => {
    try {
      setLoadingCrashLog(true)
      setSelectedCrashLog(filename)
      const res = await fetch(`/api/debug/crash-logs/${encodeURIComponent(filename)}`)
      const data = await res.json()
      if (data.content) {
        setCrashLogContent(data.content)
      } else {
        setCrashLogContent('Failed to load crash log content')
      }
    } catch {
      setCrashLogContent('Failed to load crash log content')
    } finally {
      setLoadingCrashLog(false)
    }
  }

  // Fetch recent logs
  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/debug/logs')
      const data = await res.json()
      if (data.logs) {
        setLogs(data.logs.map((log: Omit<LogEntry, 'id'>, i: number) => ({
          ...log,
          id: `log-${i}-${Date.now()}`,
          timestamp: new Date(log.timestamp)
        })))
      }
    } catch (error) {
      console.error('Failed to fetch logs:', error)
    }
  }

  useEffect(() => {
    fetchSystemInfo()
    fetchHealthStatus()
    fetchLogFiles()
    fetchLogs()
    fetchPerformanceHistory()
    fetchCrashLogs()

    // Refresh system info every 30 seconds
    const interval = setInterval(() => {
      fetchSystemInfo()
      fetchHealthStatus()
      fetchPerformanceHistory()
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  // Listen for real-time logs via Socket.IO
  useEffect(() => {
    if (!socket || paused) return

    const handleLog = (data: { level: string; message: string; timestamp: string; source?: string }) => {
      setLogs(prev => [...prev.slice(-500), {
        id: `log-${Date.now()}-${Math.random()}`,
        level: data.level as LogEntry['level'],
        message: data.message,
        timestamp: new Date(data.timestamp),
        source: data.source
      }])
    }

    socket.on('log:entry', handleLog)
    socket.emit('subscribe:logs')

    return () => {
      socket.off('log:entry', handleLog)
      socket.emit('unsubscribe:logs')
    }
  }, [socket, paused])

  const clearLogs = () => {
    setLogs([])
    toast({
      title: 'Logs cleared',
      description: 'Display cleared. Server logs remain on disk.',
    })
  }

  // Get unique sources for filter - defined before filteredLogs
  const availableSources = useMemo(() => {
    const sources = new Set<string>()
    logs.forEach(log => {
      if (log.source) sources.add(log.source)
    })
    return Array.from(sources).sort()
  }, [logs])

  // Memoize filtered logs
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      // Level filter
      if (levelFilter !== 'all' && log.level !== levelFilter) return false
      
      // Source filter
      if (sourceFilter !== 'all' && log.source !== sourceFilter) return false
      
      // Search query
      if (searchQuery) {
        const query = searchQuery.toLowerCase()
        const matchesMessage = log.message.toLowerCase().includes(query)
        const matchesSource = log.source?.toLowerCase().includes(query)
        if (!matchesMessage && !matchesSource) return false
      }
      
      return true
    })
  }, [logs, levelFilter, sourceFilter, searchQuery])

  const downloadLogs = async (format: 'txt' | 'json' = 'txt', filtered = false) => {
    let url: string | null = null
    try {
      if (filtered) {
        // Download filtered logs from current view
        const dataToExport = filteredLogs.map(log => ({
          timestamp: log.timestamp.toISOString(),
          level: log.level,
          source: log.source || 'server',
          message: log.message
        }))
        
        let content: string
        let filename: string
        let mimeType: string
        
        if (format === 'json') {
          content = JSON.stringify(dataToExport, null, 2)
          filename = `pz-logs-filtered-${new Date().toISOString().split('T')[0]}.json`
          mimeType = 'application/json'
        } else {
          content = dataToExport.map(log => 
            `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`
          ).join('\n')
          filename = `pz-logs-filtered-${new Date().toISOString().split('T')[0]}.txt`
          mimeType = 'text/plain'
        }
        
        const blob = new Blob([content], { type: mimeType })
        url = window.URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
        
        toast({
          title: 'Exported',
          description: `${filteredLogs.length} log entries exported as ${format.toUpperCase()}`,
        })
      } else {
        // Download full log file from server
        const res = await fetch('/api/debug/logs/download')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        url = window.URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `pz-manager-logs-${new Date().toISOString().split('T')[0]}.txt`
        a.click()
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to download logs',
        variant: 'destructive',
      })
    } finally {
      if (url) window.URL.revokeObjectURL(url)
    }
  }

  const copyLogEntry = (log: LogEntry) => {
    const text = `[${log.timestamp.toISOString()}] [${log.level.toUpperCase()}] ${log.source ? `[${log.source}] ` : ''}${log.message}`
    navigator.clipboard.writeText(text)
    toast({
      title: 'Copied',
      description: 'Log entry copied to clipboard',
    })
  }

  const formatMemory = (bytes: number) => {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return `${hours}h ${minutes}m`
  }

  const formatTimestamp = useCallback((date: Date): string => {
    switch (timeFormat) {
      case 'relative': {
        const now = new Date()
        const diff = now.getTime() - date.getTime()
        if (diff < 1000) return 'just now'
        if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
        return `${Math.floor(diff / 86400000)}d ago`
      }
      case 'time':
        return date.toLocaleTimeString()
      case 'datetime':
        return date.toLocaleString()
      default:
        return date.toLocaleTimeString()
    }
  }, [timeFormat])

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const handleEditPaths = () => {
    setNewDataDir(systemInfo?.dataDir || '')
    setNewLogsDir(systemInfo?.logsPath || '')
    setEditingPaths(true)
  }

  const handleSavePaths = async () => {
    if (!newDataDir && !newLogsDir) {
      toast({
        title: 'Error',
        description: 'Please enter at least one path',
        variant: 'destructive'
      })
      return
    }

    setSavingPaths(true)
    try {
      const res = await fetch('/api/debug/paths', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataDir: newDataDir || undefined,
          logsDir: newLogsDir || undefined,
          moveFiles
        })
      })

      const data = await res.json()

      if (data.success) {
        toast({
          title: 'Paths Updated',
          description: data.message,
          variant: 'success' as const
        })
        setEditingPaths(false)
        fetchSystemInfo()
      } else {
        toast({
          title: 'Error',
          description: data.error || 'Failed to update paths',
          variant: 'destructive'
        })
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update paths',
        variant: 'destructive'
      })
    } finally {
      setSavingPaths(false)
    }
  }

  const toggleLogExpanded = (logId: string) => {
    setExpandedLogs(prev => {
      const next = new Set(prev)
      if (next.has(logId)) {
        next.delete(logId)
      } else {
        next.add(logId)
      }
      return next
    })
  }

  // Log stats
  const logStats = useMemo(() => ({
    total: logs.length,
    errors: logs.filter(l => l.level === 'error').length,
    warnings: logs.filter(l => l.level === 'warn').length,
    info: logs.filter(l => l.level === 'info').length,
    debug: logs.filter(l => l.level === 'debug').length,
  }), [logs])

  const getLevelIcon = (level: string) => {
    switch (level) {
      case 'error': return <AlertCircle className="w-4 h-4 text-red-500" />
      case 'warn': return <AlertTriangle className="w-4 h-4 text-yellow-500" />
      case 'info': return <Info className="w-4 h-4 text-blue-500" />
      case 'debug': return <Bug className="w-4 h-4 text-gray-500" />
      default: return <CheckCircle className="w-4 h-4 text-green-500" />
    }
  }

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'error': return 'text-red-400'
      case 'warn': return 'text-yellow-400'
      case 'info': return 'text-blue-400'
      case 'debug': return 'text-gray-400'
      default: return 'text-green-400'
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Bug className="w-8 h-8" />
          Debug & Logs
        </h1>
        <p className="text-muted-foreground">View system information, service health, and application logs</p>
      </div>

      <Tabs defaultValue="logs" className="space-y-4">
        <TabsList>
          <TabsTrigger value="logs" className="gap-2">
            <Terminal className="w-4 h-4" />
            Logs
          </TabsTrigger>
          <TabsTrigger value="crashes" className="gap-2">
            <AlertCircle className="w-4 h-4" />
            Crashes
          </TabsTrigger>
          <TabsTrigger value="performance" className="gap-2">
            <TrendingUp className="w-4 h-4" />
            Performance
          </TabsTrigger>
          <TabsTrigger value="health" className="gap-2">
            <Activity className="w-4 h-4" />
            Health
          </TabsTrigger>
          <TabsTrigger value="system" className="gap-2">
            <Database className="w-4 h-4" />
            System
          </TabsTrigger>
        </TabsList>

        {/* Logs Tab */}
        <TabsContent value="logs" className="space-y-4">
          {/* Stats Bar */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <Card className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setLevelFilter('all')}>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total</p>
                  <p className="text-2xl font-bold">{logStats.total}</p>
                </div>
                <Terminal className="w-8 h-8 text-muted-foreground" />
              </CardContent>
            </Card>
            <Card className="cursor-pointer hover:bg-red-500/10 transition-colors" onClick={() => setLevelFilter('error')}>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Errors</p>
                  <p className="text-2xl font-bold text-red-500">{logStats.errors}</p>
                </div>
                <AlertCircle className="w-8 h-8 text-red-500" />
              </CardContent>
            </Card>
            <Card className="cursor-pointer hover:bg-yellow-500/10 transition-colors" onClick={() => setLevelFilter('warn')}>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Warnings</p>
                  <p className="text-2xl font-bold text-yellow-500">{logStats.warnings}</p>
                </div>
                <AlertTriangle className="w-8 h-8 text-yellow-500" />
              </CardContent>
            </Card>
            <Card className="cursor-pointer hover:bg-blue-500/10 transition-colors" onClick={() => setLevelFilter('info')}>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Info</p>
                  <p className="text-2xl font-bold text-blue-500">{logStats.info}</p>
                </div>
                <Info className="w-8 h-8 text-blue-500" />
              </CardContent>
            </Card>
            <Card className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setLevelFilter('debug')}>
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Debug</p>
                  <p className="text-2xl font-bold text-gray-500">{logStats.debug}</p>
                </div>
                <Bug className="w-8 h-8 text-gray-500" />
              </CardContent>
            </Card>
          </div>

          {/* Logs Card */}
          <Card>
            <CardHeader className="pb-4">
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Terminal className="w-5 h-5" />
                      Application Logs
                      {paused && (
                        <Badge variant="secondary" className="animate-pulse ml-2">
                          Paused
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription>
                      Real-time logs • {filteredLogs.length} shown of {logs.length} total
                      <span className="ml-2 text-xs">(Ctrl+F to search, Space to pause)</span>
                    </CardDescription>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button 
                            variant={paused ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setPaused(!paused)}
                          >
                            {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{paused ? 'Resume' : 'Pause'} live updates</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>

                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="outline" size="sm" onClick={fetchLogs}>
                            <RefreshCw className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Refresh logs</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>

                    <Select value="download" onValueChange={(v) => {
                      if (v === 'full-txt') downloadLogs('txt', false)
                      else if (v === 'filtered-txt') downloadLogs('txt', true)
                      else if (v === 'filtered-json') downloadLogs('json', true)
                    }}>
                      <SelectTrigger className="w-[130px] h-9">
                        <Download className="w-4 h-4 mr-2" />
                        Export
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="download" disabled>Export logs...</SelectItem>
                        <SelectItem value="full-txt">Full log file (.txt)</SelectItem>
                        <SelectItem value="filtered-txt">Filtered view (.txt)</SelectItem>
                        <SelectItem value="filtered-json">Filtered view (.json)</SelectItem>
                      </SelectContent>
                    </Select>

                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="outline" size="sm" onClick={clearLogs}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Clear display</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>

                {/* Filters Row */}
                <div className="flex flex-wrap items-center gap-3">
                  {/* Search */}
                  <div className="relative flex-1 min-w-[200px] max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      ref={searchInputRef}
                      placeholder="Search logs..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9 pr-8"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {/* Level Filter */}
                  <Select value={levelFilter} onValueChange={(v) => setLevelFilter(v as typeof levelFilter)}>
                    <SelectTrigger className="w-[120px]">
                      <SelectValue placeholder="Level" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Levels</SelectItem>
                      <SelectItem value="error">Errors</SelectItem>
                      <SelectItem value="warn">Warnings</SelectItem>
                      <SelectItem value="info">Info</SelectItem>
                      <SelectItem value="debug">Debug</SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Source Filter */}
                  <Select value={sourceFilter} onValueChange={setSourceFilter}>
                    <SelectTrigger className="w-[140px]">
                      <SelectValue placeholder="Source" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Sources</SelectItem>
                      {availableSources.map(source => (
                        <SelectItem key={source} value={source}>{source}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Time Format */}
                  <Select value={timeFormat} onValueChange={(v) => setTimeFormat(v as TimeFormat)}>
                    <SelectTrigger className="w-[130px]">
                      <Clock className="w-4 h-4 mr-2" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="time">Time only</SelectItem>
                      <SelectItem value="datetime">Date & Time</SelectItem>
                      <SelectItem value="relative">Relative</SelectItem>
                    </SelectContent>
                  </Select>

                  {/* Auto-scroll toggle */}
                  <div className="flex items-center gap-2">
                    <Switch 
                      id="auto-scroll" 
                      checked={autoScroll} 
                      onCheckedChange={setAutoScroll} 
                    />
                    <Label htmlFor="auto-scroll" className="text-sm cursor-pointer">Auto-scroll</Label>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px] bg-black rounded-lg">
                <div className="font-mono text-sm p-4">
                  {filteredLogs.length === 0 ? (
                    <div className="text-gray-500 text-center py-8">
                      {logs.length === 0 
                        ? 'No logs to display. Logs will appear here as the application runs.'
                        : 'No logs match your filters.'}
                    </div>
                  ) : (
                    filteredLogs.map((log) => {
                      const isLongMessage = log.message.length > 200
                      const isExpanded = expandedLogs.has(log.id)
                      const displayMessage = isLongMessage && !isExpanded 
                        ? log.message.substring(0, 200) + '...'
                        : log.message
                      
                      return (
                        <div 
                          key={log.id} 
                          className="group flex items-start gap-2 hover:bg-gray-900 px-2 py-1 rounded cursor-pointer"
                          onClick={() => isLongMessage && toggleLogExpanded(log.id)}
                        >
                          {isLongMessage ? (
                            isExpanded 
                              ? <ChevronDown className="w-4 h-4 text-gray-500 shrink-0 mt-0.5" />
                              : <ChevronRight className="w-4 h-4 text-gray-500 shrink-0 mt-0.5" />
                          ) : (
                            getLevelIcon(log.level)
                          )}
                          <span className="text-gray-500 shrink-0">
                            [{formatTimestamp(log.timestamp)}]
                          </span>
                          <Badge 
                            variant="outline" 
                            className={`text-xs shrink-0 ${getLevelColor(log.level)} border-current`}
                          >
                            {log.level.toUpperCase()}
                          </Badge>
                          {log.source && (
                            <Badge variant="secondary" className="text-xs shrink-0">
                              {log.source}
                            </Badge>
                          )}
                          <span className={`${getLevelColor(log.level)} break-all`}>
                            {displayMessage}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              copyLogEntry(log)
                            }}
                            className="opacity-0 group-hover:opacity-100 ml-auto shrink-0 p-1 hover:bg-gray-800 rounded transition-opacity"
                          >
                            <Copy className="w-3 h-3 text-gray-400" />
                          </button>
                        </div>
                      )
                    })
                  )}
                  <div ref={logsEndRef} />
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Log Files */}
          {logFiles.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <FileText className="w-5 h-5" />
                  Log Files on Disk
                </CardTitle>
                <CardDescription>Download or view historical log files</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {logFiles.map(file => (
                    <div key={file.name} className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
                      <div className="flex items-center gap-3">
                        <FileText className="w-4 h-4 text-muted-foreground" />
                        <div>
                          <p className="font-medium">{file.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatFileSize(file.size)} • Modified {new Date(file.modified).toLocaleString()}
                          </p>
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" asChild>
                        <a href={`/api/debug/logs/download/${file.name}`} download>
                          <Download className="w-4 h-4" />
                        </a>
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Crashes Tab */}
        <TabsContent value="crashes" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Crash Log List */}
            <Card className="lg:col-span-1">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <AlertCircle className="w-5 h-5" />
                  Crash Logs
                </CardTitle>
                <CardDescription>Java crash dumps and error logs</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex justify-end mb-3">
                  <Button variant="outline" size="sm" onClick={fetchCrashLogs}>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Refresh
                  </Button>
                </div>
                {crashLogs.length === 0 ? (
                  <p className="text-muted-foreground text-sm text-center py-4">
                    No crash logs found. That's good news!
                  </p>
                ) : (
                  <ScrollArea className="h-[400px]">
                    <div className="space-y-2">
                      {crashLogs.map((log) => (
                        <div
                          key={log.name}
                          className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                            selectedCrashLog === log.name
                              ? 'bg-primary/10 border-primary'
                              : 'hover:bg-muted/50'
                          }`}
                          onClick={() => loadCrashLogContent(log.name)}
                        >
                          <p className="font-mono text-sm truncate">{log.name}</p>
                          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                            <span>{(log.size / 1024).toFixed(1)} KB</span>
                            <span>•</span>
                            <span>{new Date(log.modified).toLocaleString()}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>

            {/* Crash Log Viewer */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <FileText className="w-5 h-5" />
                  {selectedCrashLog || 'Crash Log Viewer'}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!selectedCrashLog ? (
                  <div className="h-[400px] flex items-center justify-center text-muted-foreground">
                    Select a crash log to view its contents
                  </div>
                ) : loadingCrashLog ? (
                  <div className="h-[400px] flex items-center justify-center">
                    <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <ScrollArea className="h-[400px]">
                    <pre className="text-xs font-mono whitespace-pre-wrap break-all p-2 bg-muted/30 rounded">
                      {crashLogContent}
                    </pre>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Performance Tab */}
        <TabsContent value="performance" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Memory Usage Chart */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="w-5 h-5" />
                  Memory Usage
                </CardTitle>
              </CardHeader>
              <CardContent>
                {performanceHistory.length > 0 ? (
                  <ResponsiveContainer width="100%" height={250}>
                    <AreaChart data={performanceHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                      <XAxis dataKey="time" stroke="#888" fontSize={12} />
                      <YAxis stroke="#888" fontSize={12} unit=" MB" />
                      <RTooltip />
                      <Area 
                        type="monotone" 
                        dataKey="memoryMB" 
                        stroke="#8884d8" 
                        fill="#8884d8" 
                        fillOpacity={0.3}
                        name="Memory (MB)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[250px] flex items-center justify-center text-muted-foreground">
                    No performance data yet. Data collects over time.
                  </div>
                )}
              </CardContent>
            </Card>

            {/* CPU Load Chart */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <Activity className="w-5 h-5" />
                  CPU Load Average
                </CardTitle>
              </CardHeader>
              <CardContent>
                {performanceHistory.length > 0 ? (
                  <ResponsiveContainer width="100%" height={250}>
                    <LineChart data={performanceHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                      <XAxis dataKey="time" stroke="#888" fontSize={12} />
                      <YAxis stroke="#888" fontSize={12} />
                      <RTooltip />
                      <Line 
                        type="monotone" 
                        dataKey="cpuLoad" 
                        stroke="#82ca9d" 
                        strokeWidth={2}
                        dot={false}
                        name="CPU Load"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[250px] flex items-center justify-center text-muted-foreground">
                    No performance data yet. Data collects over time.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Current Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Current Memory</p>
                <p className="text-2xl font-bold">
                  {performanceHistory.length > 0 
                    ? `${performanceHistory[performanceHistory.length - 1].memoryMB} MB`
                    : 'N/A'}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Peak Memory</p>
                <p className="text-2xl font-bold">
                  {performanceHistory.length > 0 
                    ? `${Math.max(...performanceHistory.map(p => p.memoryMB || 0))} MB`
                    : 'N/A'}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Current CPU Load</p>
                <p className="text-2xl font-bold">
                  {performanceHistory.length > 0 
                    ? performanceHistory[performanceHistory.length - 1].cpuLoad?.toFixed(2) || 'N/A'
                    : 'N/A'}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Data Points</p>
                <p className="text-2xl font-bold">{performanceHistory.length}</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Health Tab */}
        <TabsContent value="health" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Overall Status */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <Activity className="w-5 h-5" />
                  System Status
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  <div className={`w-16 h-16 rounded-full flex items-center justify-center ${
                    healthStatus?.status === 'ok' ? 'bg-green-500/20' : 'bg-red-500/20'
                  }`}>
                    {healthStatus?.status === 'ok' 
                      ? <CheckCircle className="w-8 h-8 text-green-500" />
                      : <AlertCircle className="w-8 h-8 text-red-500" />
                    }
                  </div>
                  <div>
                    <p className="text-2xl font-bold">
                      {healthStatus?.status === 'ok' ? 'Healthy' : 'Issues Detected'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Last checked: {healthStatus?.timestamp 
                        ? new Date(healthStatus.timestamp).toLocaleTimeString()
                        : 'Never'}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Memory Usage */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <Database className="w-5 h-5" />
                  Memory Usage
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {healthStatus?.memory && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Heap Used</span>
                      <span className="font-mono">{formatMemory(healthStatus.memory.heapUsed)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Heap Total</span>
                      <span className="font-mono">{formatMemory(healthStatus.memory.heapTotal)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">RSS</span>
                      <span className="font-mono">{formatMemory(healthStatus.memory.rss)}</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2 mt-2">
                      <div 
                        className="bg-primary h-2 rounded-full transition-all"
                        style={{ 
                          width: `${Math.min(100, (healthStatus.memory.heapUsed / healthStatus.memory.heapTotal) * 100)}%` 
                        }}
                      />
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Services Status */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Zap className="w-5 h-5" />
                  Services
                </CardTitle>
                <Button variant="outline" size="sm" onClick={fetchHealthStatus}>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* RCON Service */}
                <div className="p-4 rounded-lg border bg-card">
                  <div className="flex items-center gap-3 mb-3">
                    {healthStatus?.services.rcon.connected 
                      ? <Wifi className="w-5 h-5 text-green-500" />
                      : <WifiOff className="w-5 h-5 text-red-500" />
                    }
                    <span className="font-medium">RCON</span>
                    <Badge variant={healthStatus?.services.rcon.connected ? 'default' : 'destructive'} className="ml-auto">
                      {healthStatus?.services.rcon.connected ? 'Connected' : 'Disconnected'}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Host: {healthStatus?.services.rcon.host || 'Not configured'}
                  </p>
                </div>

                {/* Server Status */}
                <div className="p-4 rounded-lg border bg-card">
                  <div className="flex items-center gap-3 mb-3">
                    <Server className={`w-5 h-5 ${healthStatus?.services.server.running ? 'text-green-500' : 'text-gray-500'}`} />
                    <span className="font-medium">Game Server</span>
                    <Badge variant={healthStatus?.services.server.running ? 'default' : 'secondary'} className="ml-auto">
                      {healthStatus?.services.server.running ? 'Running' : 'Stopped'}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Project Zomboid dedicated server
                  </p>
                </div>

                {/* Mod Checker */}
                <div className="p-4 rounded-lg border bg-card">
                  <div className="flex items-center gap-3 mb-3">
                    <Settings className={`w-5 h-5 ${healthStatus?.services.modChecker.running ? 'text-green-500' : 'text-gray-500'}`} />
                    <span className="font-medium">Mod Checker</span>
                    <Badge variant={healthStatus?.services.modChecker.running ? 'default' : 'secondary'} className="ml-auto">
                      {healthStatus?.services.modChecker.running ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Interval: {healthStatus?.services.modChecker.interval 
                      ? `${Math.floor(healthStatus.services.modChecker.interval / 60000)}m`
                      : 'N/A'}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Uptime */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <Clock className="w-5 h-5" />
                Uptime
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">
                {healthStatus ? formatUptime(healthStatus.uptime) : '-'}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Since {healthStatus 
                  ? new Date(Date.now() - healthStatus.uptime * 1000).toLocaleString()
                  : '-'}
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* System Tab */}
        <TabsContent value="system" className="space-y-4">
          {/* System Info Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Node.js</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold">{systemInfo?.nodeVersion || '-'}</span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Platform</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold">{systemInfo?.platform || '-'}</span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Uptime</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold">
                  {systemInfo ? formatUptime(systemInfo.uptime) : '-'}
                </span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Memory</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-bold">
                  {systemInfo ? formatMemory(systemInfo.memoryUsage.heapUsed) : '-'}
                </span>
                <p className="text-xs text-muted-foreground mt-1">
                  of {systemInfo ? formatMemory(systemInfo.memoryUsage.heapTotal) : '-'} heap
                </p>
              </CardContent>
            </Card>
          </div>

          {/* File Paths */}
          <Card className="card-interactive">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                    <FolderOpen className="w-5 h-5 text-amber-500" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">File Paths</CardTitle>
                    <CardDescription className="mt-0.5">Data and log file locations</CardDescription>
                  </div>
                </div>
                {!editingPaths && (
                  <Button variant="outline" size="sm" onClick={handleEditPaths}>
                    Change Paths
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {editingPaths ? (
                <div className="space-y-4">
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-medium text-amber-600 dark:text-amber-400">Restart Required</p>
                        <p className="text-muted-foreground">Changing paths requires restarting the application to take effect.</p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="dataDir">Data Directory (contains db.json)</Label>
                    <Input
                      id="dataDir"
                      value={newDataDir}
                      onChange={(e) => setNewDataDir(e.target.value)}
                      placeholder="C:\MyApp\data"
                      className="font-mono"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="logsDir">Logs Directory</Label>
                    <Input
                      id="logsDir"
                      value={newLogsDir}
                      onChange={(e) => setNewLogsDir(e.target.value)}
                      placeholder="C:\MyApp\logs"
                      className="font-mono"
                    />
                  </div>

                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <Checkbox
                      id="moveFiles"
                      checked={moveFiles}
                      onCheckedChange={(checked) => setMoveFiles(checked === true)}
                    />
                    <div>
                      <Label htmlFor="moveFiles" className="cursor-pointer">Move existing files to new location</Label>
                      <p className="text-sm text-muted-foreground">Copy current data and logs to the new paths</p>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button onClick={handleSavePaths} disabled={savingPaths} className="gap-2">
                      {savingPaths ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      Save Paths
                    </Button>
                    <Button variant="outline" onClick={() => setEditingPaths(false)} disabled={savingPaths}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 font-mono text-sm">
                  <div className="flex gap-4 p-3 rounded-lg bg-muted/50">
                    <span className="text-muted-foreground w-32 shrink-0">Database:</span>
                    <span className="break-all">{systemInfo?.dbPath || '-'}</span>
                  </div>
                  <div className="flex gap-4 p-3 rounded-lg bg-muted/50">
                    <span className="text-muted-foreground w-32 shrink-0">Logs folder:</span>
                    <span className="break-all">{systemInfo?.logsPath || '-'}</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
