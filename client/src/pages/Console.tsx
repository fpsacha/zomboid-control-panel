import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { Terminal as TerminalIcon, Send, Trash2, Wifi, WifiOff, Loader2, Megaphone, MessageCircle, FileText, RefreshCw, Pause, Play, Filter } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import { rconApi, configApi, serverApi } from '@/lib/api'
import { useSocket } from '@/contexts/SocketContext'

interface CommandEntry {
  id: number
  command: string
  response: string
  success: number
  executed_at: string
}

interface RconResponse {
  command: string
  response: string
  success: boolean
  timestamp: string
}

// Parse PZ server log line into structured parts
interface ParsedLogLine {
  type: 'LOG' | 'WARN' | 'ERROR' | 'DEBUG' | 'INFO' | 'UNKNOWN'
  category: string
  message: string
  raw: string
}

function parseLogLine(line: string): ParsedLogLine {
  // PZ log format: "TYPE : Category    f:XXXXX, t:XXXXX, st:XXXXX> Source > Message"
  // or just plain text
  
  const trimmed = line.trim()
  if (!trimmed) {
    return { type: 'UNKNOWN', category: '', message: '', raw: line }
  }
  
  // Match: LOG/WARN/ERROR : Category  f:xxx...> Message
  const match = trimmed.match(/^(LOG|WARN|ERROR|DEBUG|INFO)\s*:\s*(\w+).*?>\s*(.+)$/i)
  if (match) {
    return {
      type: match[1].toUpperCase() as ParsedLogLine['type'],
      category: match[2],
      message: match[3],
      raw: line
    }
  }
  
  // Check for simple prefixes
  if (trimmed.startsWith('ERROR')) {
    return { type: 'ERROR', category: '', message: trimmed.replace(/^ERROR\s*:?\s*/i, ''), raw: line }
  }
  if (trimmed.startsWith('WARN')) {
    return { type: 'WARN', category: '', message: trimmed.replace(/^WARN\s*:?\s*/i, ''), raw: line }
  }
  if (trimmed.startsWith('LOG')) {
    return { type: 'LOG', category: '', message: trimmed.replace(/^LOG\s*:?\s*/i, ''), raw: line }
  }
  
  return { type: 'UNKNOWN', category: '', message: trimmed, raw: line }
}

export default function Console() {
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<CommandEntry[]>([])
  const [liveLog, setLiveLog] = useState<RconResponse[]>([])
  const [loading, setLoading] = useState(false)
  const [commandHistoryIndex, setCommandHistoryIndex] = useState(-1)
  const [commandCache, setCommandCache] = useState<string[]>([])
  const [rconConnected, setRconConnected] = useState<boolean | null>(null)
  const [testingConnection, setTestingConnection] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [channelMessage, setChannelMessage] = useState('')
  const [selectedChannel, setSelectedChannel] = useState('say')
  const [sendingAnnouncement, setSendingAnnouncement] = useState(false)
  const [sendingChannelMessage, setSendingChannelMessage] = useState(false)
  const [historySearch, setHistorySearch] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  const socket = useSocket()
  
  // Server Console Log state
  const [serverLogLines, setServerLogLines] = useState<string[]>([])
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_serverLogSize, setServerLogSize] = useState(0)
  const [serverLogPath, setServerLogPath] = useState('')
  const [serverLogExists, setServerLogExists] = useState(false)
  const [serverLogLoading, setServerLogLoading] = useState(false)
  const [serverLogAutoScroll, setServerLogAutoScroll] = useState(true)
  const [serverLogPaused, setServerLogPaused] = useState(false)
  const [serverLogFiltered, setServerLogFiltered] = useState(true) // Filter out noise by default
  const serverLogRef = useRef<HTMLDivElement>(null)
  const serverLogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const serverLogSizeRef = useRef(0) // Track size without recreating interval

  // Patterns to filter out (uninteresting/repetitive messages) - memoized to prevent recreation
  const noisePatterns = useMemo(() => [
    /moveZombie: There are no zombies/i,
    /ItemPickInfo -> cannot get ID for container/i,
    /IsoThumpable not found on square/i,
    /SpriteConfig\.initObjectInfo.*Invalid SpriteConfig/i,
    /MOWoodenWalFrame\.lua: replacing isoObject/i,
    /OreVein\{startPoint/i,
    /SkeletonBone not resolved for bone/i,
    /action was null, object: null/i,
    /Could not find item type for/i,
    /Canceled loading wrong transition/i,
  ], [])

  // Get filtered lines - memoized to prevent recalculation on every render
  const filteredLogLines = useMemo(() => {
    if (!serverLogFiltered) return serverLogLines
    return serverLogLines.filter(line => !noisePatterns.some(pattern => pattern.test(line)))
  }, [serverLogLines, serverLogFiltered, noisePatterns])

  const fetchHistory = useCallback(async () => {
    try {
      const data = await rconApi.getHistory(50)
      setHistory(data.history || [])
      setCommandCache(data.history?.map((h: CommandEntry) => h.command).reverse() || [])
    } catch (error) {
      console.error('Failed to fetch history:', error)
    }
  }, [])

  const testRconConnection = useCallback(async () => {
    setTestingConnection(true)
    try {
      const result = await configApi.testRcon()
      setRconConnected(result.success && result.connected)
    } catch {
      setRconConnected(false)
    } finally {
      setTestingConnection(false)
    }
  }, [])

  // Server Console Log functions
  const fetchServerLog = useCallback(async (initial = false) => {
    if (serverLogPausedRef.current && !initial) return
    
    try {
      if (initial) {
        setServerLogLoading(true)
        const data = await serverApi.getConsoleLog(1000)
        setServerLogLines(data.lines || [])
        setServerLogSize(data.size || 0)
        serverLogSizeRef.current = data.size || 0
        setServerLogPath(data.path || '')
        setServerLogExists(data.exists || false)
      } else {
        // Stream new content - use ref to avoid stale closure
        const data = await serverApi.streamConsoleLog(serverLogSizeRef.current)
        if (data.newLines && data.newLines.length > 0) {
          setServerLogLines(prev => [...prev, ...data.newLines].slice(-2000))
        }
        if (data.rotated) {
          // File was rotated, replace all content
          setServerLogLines(data.newLines || [])
        }
        setServerLogSize(data.currentSize || serverLogSizeRef.current)
        serverLogSizeRef.current = data.currentSize || serverLogSizeRef.current
      }
    } catch (error) {
      console.error('Failed to fetch server log:', error)
    } finally {
      setServerLogLoading(false)
    }
  }, []) // No deps - uses refs for mutable state

  const clearServerLog = async () => {
    try {
      await serverApi.clearConsoleLog()
      setServerLogLines([])
      setServerLogSize(0)
      toast({
        title: 'Log Cleared',
        description: 'Server console log has been cleared',
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to clear server log',
        variant: 'destructive',
      })
    }
  }

  // Ref to track paused state for interval callback (avoids stale closure)
  const serverLogPausedRef = useRef(serverLogPaused)
  useEffect(() => {
    serverLogPausedRef.current = serverLogPaused
  }, [serverLogPaused])

  // Start/stop server log polling
  useEffect(() => {
    // Initial fetch
    fetchServerLog(true)
    
    // Poll every 2 seconds for new log content
    serverLogIntervalRef.current = setInterval(() => {
      if (!serverLogPausedRef.current) {
        fetchServerLog(false)
      }
    }, 2000)
    
    return () => {
      if (serverLogIntervalRef.current) {
        clearInterval(serverLogIntervalRef.current)
      }
    }
  }, [fetchServerLog])

  // Auto-scroll server log
  useEffect(() => {
    if (serverLogAutoScroll && serverLogRef.current) {
      serverLogRef.current.scrollTop = serverLogRef.current.scrollHeight
    }
  }, [serverLogLines, serverLogAutoScroll])

  useEffect(() => {
    fetchHistory()
    testRconConnection()
    // Auto-focus input on mount
    inputRef.current?.focus()
  }, [fetchHistory, testRconConnection])

  useEffect(() => {
    if (socket) {
      const handleRconResponse = (data: RconResponse) => {
        setLiveLog(prev => [...prev, data].slice(-100))
        // If we get a response, RCON is connected
        setRconConnected(true)
      }

      socket.on('rcon:response', handleRconResponse)

      return () => {
        socket.off('rcon:response', handleRconResponse)
      }
    }
  }, [socket])

  useEffect(() => {
    // Auto-scroll to bottom
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [liveLog])

  const executeCommand = async () => {
    if (!command.trim()) return

    setLoading(true)
    try {
      const result = await rconApi.execute(command)
      
      // Update connection status based on result
      if (result.error?.includes('Server is not running') || result.error?.includes('ECONNREFUSED')) {
        setRconConnected(false)
      } else if (result.success) {
        setRconConnected(true)
      }
      
      // Add to live log
      setLiveLog(prev => [...prev, {
        command,
        response: result.response || result.error || 'No response',
        success: result.success,
        timestamp: new Date().toISOString()
      }].slice(-100))

      // Add to command cache (limit to 100 entries)
      setCommandCache(prev => [...prev.slice(-99), command])
      setCommandHistoryIndex(-1)
      setCommand('')
      
      // Re-focus input after command execution
      inputRef.current?.focus()
      
      fetchHistory()
    } catch (error) {
      setRconConnected(false)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Command failed',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      executeCommand()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (commandCache.length > 0) {
        const newIndex = commandHistoryIndex < commandCache.length - 1 
          ? commandHistoryIndex + 1 
          : commandHistoryIndex
        setCommandHistoryIndex(newIndex)
        setCommand(commandCache[commandCache.length - 1 - newIndex] || '')
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (commandHistoryIndex > 0) {
        const newIndex = commandHistoryIndex - 1
        setCommandHistoryIndex(newIndex)
        setCommand(commandCache[commandCache.length - 1 - newIndex] || '')
      } else if (commandHistoryIndex === 0) {
        setCommandHistoryIndex(-1)
        setCommand('')
      }
    }
  }

  const clearLog = () => {
    setLiveLog([])
  }

  // Chat channels available in PZ
  const chatChannels = [
    { value: 'say', label: 'Local (Say)', description: 'Nearby players only' },
    { value: 'all', label: 'General', description: 'All players' },
    { value: 'admin', label: 'Admin', description: 'Admin chat' },
    { value: 'faction', label: 'Faction', description: 'Faction members' },
    { value: 'safehouse', label: 'Safehouse', description: 'Safehouse members' },
  ]

  const sendAnnouncement = async () => {
    if (!announcement.trim()) return
    
    setSendingAnnouncement(true)
    try {
      const result = await rconApi.execute(`servermsg "${announcement.replace(/"/g, '\\"')}"`)
      
      setLiveLog(prev => [...prev, {
        command: `servermsg "${announcement}"`,
        response: result.response || result.error || 'Announcement sent',
        success: result.success,
        timestamp: new Date().toISOString()
      }].slice(-100))
      
      if (result.success) {
        toast({
          title: 'Announcement Sent',
          description: 'Your message was broadcast to all players',
          variant: 'success' as const,
        })
        setAnnouncement('')
        setRconConnected(true)
      } else {
        throw new Error(result.error || 'Failed to send announcement')
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to send announcement',
        variant: 'destructive',
      })
    } finally {
      setSendingAnnouncement(false)
    }
  }

  const sendChannelMessage = async () => {
    if (!channelMessage.trim()) return
    
    setSendingChannelMessage(true)
    try {
      // Use the appropriate command based on channel
      // PZ uses: additem/say commands or direct chat commands
      const chatCommand = selectedChannel === 'all' 
        ? `servermsg "${channelMessage.replace(/"/g, '\\"')}"` 
        : `servermsg "[${selectedChannel.toUpperCase()}] ${channelMessage.replace(/"/g, '\\"')}"`
      
      const result = await rconApi.execute(chatCommand)
      
      setLiveLog(prev => [...prev, {
        command: chatCommand,
        response: result.response || result.error || 'Message sent',
        success: result.success,
        timestamp: new Date().toISOString()
      }].slice(-100))
      
      if (result.success) {
        toast({
          title: 'Message Sent',
          description: `Message sent to ${chatChannels.find(c => c.value === selectedChannel)?.label || selectedChannel}`,
          variant: 'success' as const,
        })
        setChannelMessage('')
        setRconConnected(true)
      } else {
        throw new Error(result.error || 'Failed to send message')
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to send message',
        variant: 'destructive',
      })
    } finally {
      setSendingChannelMessage(false)
    }
  }

  const quickCommands = [
    { label: 'Players', command: 'players' },
    { label: 'Save', command: 'save' },
    { label: 'Show Options', command: 'showoptions' },
    { label: 'Check Mods', command: 'checkModsNeedUpdate' },
    { label: 'Help', command: 'help' },
    { label: 'Server Info', command: 'serverinfo' },
    { label: 'Get Memory', command: 'getmemory' },
  ]
  
  // Quick broadcast message templates
  const quickBroadcasts = [
    { label: 'Restart 15min', message: 'SERVER RESTART in 15 minutes - Please find a safe location!' },
    { label: 'Restart 5min', message: 'SERVER RESTART in 5 minutes - Save your progress!' },
    { label: 'Restart 1min', message: 'SERVER RESTART in 1 minute - Disconnecting soon!' },
    { label: 'Maintenance', message: 'Server entering MAINTENANCE MODE - Please disconnect' },
    { label: 'Back Online', message: 'Server maintenance complete - Welcome back!' },
    { label: 'Save Warning', message: 'Server is saving - Brief lag expected' },
  ]

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Console</h1>
          <p className="text-muted-foreground text-sm sm:text-base">Server console output and RCON commands</p>
        </div>
      </div>

      <Tabs defaultValue="server-log" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="server-log" className="flex items-center gap-2">
            <FileText className="w-4 h-4" />
            Server Console
          </TabsTrigger>
          <TabsTrigger value="rcon" className="flex items-center gap-2">
            <TerminalIcon className="w-4 h-4" />
            RCON Console
          </TabsTrigger>
        </TabsList>

        {/* Server Console Log Tab */}
        <TabsContent value="server-log" className="space-y-4">
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="w-5 h-5" />
                  Server Console Output
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  {serverLogPath ? serverLogPath : 'Loading...'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {serverLogLoading && (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setServerLogPaused(!serverLogPaused)}
                  title={serverLogPaused ? 'Resume auto-update' : 'Pause auto-update'}
                >
                  {serverLogPaused ? (
                    <Play className="w-4 h-4" />
                  ) : (
                    <Pause className="w-4 h-4" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setServerLogFiltered(!serverLogFiltered)}
                  title={serverLogFiltered ? 'Show all messages (including noise)' : 'Filter out repetitive messages'}
                  className={serverLogFiltered ? 'text-primary' : ''}
                >
                  <Filter className="w-4 h-4 mr-1" />
                  <span className="text-xs">{serverLogFiltered ? 'Filtered' : 'All'}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setServerLogAutoScroll(!serverLogAutoScroll)}
                  title={serverLogAutoScroll ? 'Disable auto-scroll' : 'Enable auto-scroll'}
                  className={serverLogAutoScroll ? 'text-primary' : ''}
                >
                  <span className="text-xs">Auto-scroll</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => fetchServerLog(true)}
                  title="Refresh log"
                >
                  <RefreshCw className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={clearServerLog}>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Clear
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {!serverLogExists ? (
                <div className="bg-black/50 rounded-lg p-4 h-[500px] flex items-center justify-center">
                  <p className="text-muted-foreground">
                    Server console log not found. Make sure the server is running.
                  </p>
                </div>
              ) : (
                <div
                  ref={serverLogRef}
                  className="bg-black/50 rounded-lg p-2 h-[500px] overflow-auto font-mono text-xs"
                >
                  {filteredLogLines.length === 0 ? (
                    <p className="text-muted-foreground p-2">{serverLogFiltered && serverLogLines.length > 0 ? 'All messages filtered out. Try disabling the filter.' : 'Console log is empty.'}</p>
                  ) : (
                    filteredLogLines.map((line, index) => {
                      const parsed = parseLogLine(line)
                      if (!parsed.message && !parsed.raw.trim()) return null
                      
                      const typeColors: Record<string, string> = {
                        'ERROR': 'bg-red-500/20 text-red-400 border-red-500/30',
                        'WARN': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
                        'LOG': 'text-green-400',
                        'DEBUG': 'text-blue-400',
                        'INFO': 'text-cyan-400',
                        'UNKNOWN': 'text-gray-400'
                      }
                      
                      const typeBadgeColors: Record<string, string> = {
                        'ERROR': 'bg-red-500 text-white',
                        'WARN': 'bg-yellow-500 text-black',
                        'LOG': 'bg-green-600 text-white',
                        'DEBUG': 'bg-blue-500 text-white',
                        'INFO': 'bg-cyan-500 text-white',
                        'UNKNOWN': 'bg-gray-600 text-white'
                      }
                      
                      return (
                        <div
                          key={index}
                          className={`py-1 px-2 border-l-2 mb-0.5 ${
                            parsed.type === 'ERROR' ? 'border-red-500 bg-red-500/10' :
                            parsed.type === 'WARN' ? 'border-yellow-500 bg-yellow-500/5' :
                            parsed.type === 'LOG' ? 'border-green-500/50' :
                            'border-transparent'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            {parsed.type !== 'UNKNOWN' && (
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${typeBadgeColors[parsed.type]}`}>
                                {parsed.type}
                              </span>
                            )}
                            {parsed.category && (
                              <span className="text-purple-400 shrink-0">[{parsed.category}]</span>
                            )}
                            <span className={`${typeColors[parsed.type]} break-words`}>
                              {parsed.message || parsed.raw}
                            </span>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              )}
              <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                <span>
                  {serverLogFiltered 
                    ? `${filteredLogLines.length} lines shown (${serverLogLines.length - filteredLogLines.length} filtered)` 
                    : `${serverLogLines.length} lines loaded`}
                </span>
                <span>{serverLogPaused ? 'Paused' : 'Live updating every 2s'}</span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* RCON Console Tab */}
        <TabsContent value="rcon" className="space-y-4">
          <div className="flex items-center justify-end gap-2">
            {testingConnection ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Testing...</span>
              </div>
            ) : rconConnected === null ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="text-sm">Unknown</span>
              </div>
            ) : rconConnected ? (
              <div className="flex items-center gap-2 text-green-500">
                <Wifi className="w-4 h-4" />
                <span className="text-sm font-medium">Connected</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-red-500">
                <WifiOff className="w-4 h-4" />
                <span className="text-sm font-medium">Disconnected</span>
              </div>
            )}
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={testRconConnection}
              disabled={testingConnection}
            >
              Refresh
            </Button>
          </div>

      {/* RCON Disconnected Warning */}
      {rconConnected === false && (
        <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4 flex items-center gap-3">
          <WifiOff className="w-5 h-5 text-red-500 shrink-0" />
          <div>
            <p className="font-medium text-red-500">RCON Not Connected</p>
            <p className="text-sm text-muted-foreground">
              Make sure the server is running and RCON is configured in Settings.
            </p>
          </div>
        </div>
      )}

      {/* Quick Commands */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Quick Commands</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {quickCommands.map((qc) => (
              <Button
                key={qc.command}
                variant="secondary"
                size="sm"
                onClick={() => {
                  setCommand(qc.command)
                  inputRef.current?.focus()
                }}
              >
                {qc.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Messaging Section */}
      <div className="grid gap-4 sm:gap-6 grid-cols-1 lg:grid-cols-2">
        {/* Server Announcement */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Megaphone className="w-5 h-5" />
              Server Announcement
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Broadcast a message to all players on the server.
            </p>
            
            {/* Quick Broadcast Templates */}
            <div className="flex flex-wrap gap-1.5">
              {quickBroadcasts.map((qb) => (
                <Button
                  key={qb.label}
                  variant="outline"
                  size="sm"
                  className="text-xs h-7"
                  onClick={() => setAnnouncement(qb.message)}
                  disabled={rconConnected === false}
                >
                  {qb.label}
                </Button>
              ))}
            </div>
            
            <Textarea
              value={announcement}
              onChange={(e) => setAnnouncement(e.target.value)}
              placeholder="Enter announcement message..."
              className="min-h-[80px]"
              disabled={sendingAnnouncement || rconConnected === false}
            />
            <Button 
              onClick={sendAnnouncement} 
              disabled={sendingAnnouncement || !announcement.trim() || rconConnected === false}
              className="w-full"
            >
              {sendingAnnouncement ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Megaphone className="w-4 h-4 mr-2" />
              )}
              Send Announcement
            </Button>
          </CardContent>
        </Card>

        {/* Channel Message */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageCircle className="w-5 h-5" />
              Channel Message
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Send a message to a specific chat channel.
            </p>
            <Select value={selectedChannel} onValueChange={setSelectedChannel}>
              <SelectTrigger>
                <SelectValue placeholder="Select channel" />
              </SelectTrigger>
              <SelectContent>
                {chatChannels.map((channel) => (
                  <SelectItem key={channel.value} value={channel.value}>
                    <div className="flex flex-col">
                      <span>{channel.label}</span>
                      <span className="text-xs text-muted-foreground">{channel.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={channelMessage}
              onChange={(e) => setChannelMessage(e.target.value)}
              placeholder="Enter message..."
              disabled={sendingChannelMessage || rconConnected === false}
              onKeyDown={(e: React.KeyboardEvent) => e.key === 'Enter' && sendChannelMessage()}
            />
            <Button 
              onClick={sendChannelMessage} 
              disabled={sendingChannelMessage || !channelMessage.trim() || rconConnected === false}
              className="w-full"
            >
              {sendingChannelMessage ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Send className="w-4 h-4 mr-2" />
              )}
              Send to {chatChannels.find(c => c.value === selectedChannel)?.label || 'Channel'}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Console */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <TerminalIcon className="w-5 h-5" />
            Console Output
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={clearLog}>
            <Trash2 className="w-4 h-4 mr-2" />
            Clear
          </Button>
        </CardHeader>
        <CardContent>
          <div 
            ref={scrollRef}
            className="bg-black/50 rounded-lg p-4 h-[400px] overflow-auto terminal-output"
          >
            {liveLog.length === 0 ? (
              <p className="text-muted-foreground">No commands executed yet. Type a command below.</p>
            ) : (
              liveLog.map((entry, index) => (
                <div key={`${entry.timestamp}-${entry.command}`} className="mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-primary">{'>'}</span>
                    <span className="text-blue-400">{entry.command}</span>
                    <span className="text-muted-foreground text-xs ml-auto">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className={`ml-4 ${entry.success ? 'text-green-400' : 'text-red-400'}`}>
                    {entry.response.split('\n').map((line, i) => (
                      <div key={`line-${i}`}>{line || '\u00A0'}</div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Quick Commands */}
          <div className="flex flex-wrap gap-2 mt-4">
             {['players', 'save', 'quit', 'broadcast', 'chopper', 'gunfire'].map(cmd => (
               <Button
                 key={cmd}
                 variant="outline"
                 size="sm"
                 className="h-7 text-xs font-mono"
                 onClick={() => {
                    const newCommand = cmd === 'broadcast' ? 'servermsg "Message"' : cmd
                    setCommand(newCommand)
                    inputRef.current?.focus()
                    // If broadcast, select the message part for easy editing
                    if (cmd === 'broadcast') {
                      setTimeout(() => inputRef.current?.setSelectionRange(11, 18), 10)
                    }
                 }}
               >
                 {cmd}
               </Button>
             ))}
          </div>

          {/* Command Input */}
          <div className="flex gap-2 mt-2">
            <div className="flex-1 relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-primary" aria-hidden="true">{'>'}</span>
              <Input
                ref={inputRef}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Enter command..."
                className="pl-8 font-mono"
                disabled={loading}
                aria-label="RCON command input"
              />
            </div>
            <Button 
              onClick={executeCommand} 
              disabled={loading || !command.trim()}
              aria-label="Execute command"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Use ↑/↓ arrows to navigate command history. Press Enter to execute.
          </p>
        </CardContent>
      </Card>

      {/* Command History */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>Command History</CardTitle>
            <div className="relative w-48">
              <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search commands..."
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[300px]">
            {history.length === 0 ? (
              <p className="text-muted-foreground text-center py-4">No command history</p>
            ) : (
              <div className="space-y-2">
                {history
                  .filter(entry => 
                    !historySearch || 
                    entry.command.toLowerCase().includes(historySearch.toLowerCase()) ||
                    entry.response?.toLowerCase().includes(historySearch.toLowerCase())
                  )
                  .map((entry) => (
                  <div
                    key={entry.id}
                    className="p-3 rounded-lg border hover:bg-muted/50 cursor-pointer"
                    onClick={() => {
                      setCommand(entry.command)
                      inputRef.current?.focus()
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        setCommand(entry.command)
                        inputRef.current?.focus()
                      }
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <code className="text-sm font-mono text-primary">{entry.command}</code>
                      <span className="text-xs text-muted-foreground">
                        {new Date(entry.executed_at).toLocaleString()}
                      </span>
                    </div>
                    {entry.response && (
                      <p className={`text-xs mt-1 truncate ${entry.success ? 'text-green-400' : 'text-red-400'}`}>
                        {entry.response}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
