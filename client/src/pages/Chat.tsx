import { useState, useEffect, useCallback, useRef } from 'react'
import { 
  MessagesSquare,
  Send,
  Users,
  Megaphone,
  Loader2,
  RefreshCw,
  Info,
  AlertCircle,
  Shield,
  MessageSquare,
  Bell
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import { panelBridgeApi, playersApi, rconApi } from '@/lib/api'
import { useSocket } from '@/contexts/SocketContext'
import { EmptyState } from '@/components/EmptyState'

interface ChatMessage {
  id: string
  type: 'server' | 'admin' | 'general' | 'alert'
  author?: string
  message: string
  timestamp: Date
}

interface Player {
  name: string
  online: boolean
}

type ChatChannel = 'server' | 'admin' | 'general' | 'alert'

export default function Chat() {
  const [message, setMessage] = useState('')
  const [channel, setChannel] = useState<ChatChannel>('server')
  const [authorName, setAuthorName] = useState('Server')
  const [players, setPlayers] = useState<Player[]>([])
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [bridgeConnected, setBridgeConnected] = useState(false)
  const [bridgeLoading, setBridgeLoading] = useState(true)
  
  const chatEndRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()
  const socket = useSocket()

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [chatHistory])

  const fetchPlayers = useCallback(async () => {
    try {
      const data = await playersApi.getPlayers()
      if (data.players) {
        setPlayers(data.players)
      }
    } catch (error) {
      console.error('Failed to fetch players:', error)
    }
  }, [])

  const checkBridgeStatus = useCallback(async () => {
    try {
      setBridgeLoading(true)
      const status = await panelBridgeApi.getStatus()
      setBridgeConnected(status.modConnected && status.isRunning)
    } catch {
      setBridgeConnected(false)
    } finally {
      setBridgeLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPlayers()
    checkBridgeStatus()
    const interval = setInterval(() => {
      fetchPlayers()
    }, 15000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPlayers]) // checkBridgeStatus only runs once on mount, socket handles updates

  // Listen for bridge status updates via socket
  useEffect(() => {
    if (socket) {
      const handleBridgeStatus = (data: { modConnected: boolean; isRunning: boolean }) => {
        setBridgeConnected(data.modConnected && data.isRunning)
      }

      const handleSocketMessage = (data: any) => {
        setChatHistory(prev => {
             // Deduplication: Check if we have a message with same content/author in last 2 seconds
             // This prevents echoing our own messages if we optimistically added them
             const recent = prev.slice(-5);
             const isDuplicate = recent.some(m => 
                 m.message === data.message && 
                 m.author === data.author &&
                 Math.abs(new Date(m.timestamp).getTime() - new Date(data.timestamp).getTime()) < 2000
             );
             if (isDuplicate) return prev;

             const newMessage: ChatMessage = {
                id: data.id || Date.now().toString(),
                type: 'general',
                author: data.author,
                message: data.message,
                timestamp: new Date(data.timestamp || Date.now())
             };

             return [...prev, newMessage].slice(-200);
        });
      }

      socket.on('panelbridge:status', handleBridgeStatus)
      socket.on('chat:message', handleSocketMessage)

      return () => {
        socket.off('panelbridge:status', handleBridgeStatus)
        socket.off('chat:message', handleSocketMessage)
      }
    }
  }, [socket])

  const getChannelLabel = (ch: ChatChannel): string => {
    switch (ch) {
      case 'server': return 'Server Chat'
      case 'admin': return 'Admin Only'
      case 'general': return 'General'
      case 'alert': return 'Alert'
      default: return ch
    }
  }

  const sendMessage = async () => {
    if (!message.trim()) return

    setSending(true)
    try {
      let result
      let channelLabel = getChannelLabel(channel)

      if (bridgeConnected) {
        // Use powerful Mod API if available
        switch (channel) {
            case 'server':
            result = await panelBridgeApi.sendToServerChat(message, false)
            break
            case 'alert':
            result = await panelBridgeApi.sendToServerChat(message, true)
            channelLabel = 'Alert'
            break
            case 'admin':
            result = await panelBridgeApi.sendToAdminChat(message)
            break
            case 'general':
            result = await panelBridgeApi.sendToGeneralChat(message, authorName)
            channelLabel = `${authorName}`
            break
        }
      } else {
        // Fallback to RCON
        // RCON works best for 'server' broadcasts.
        // For general/admin, we just use servermsg with prefix
        const safeMessage = message.replace(/"/g, '\\"');
        
        switch (channel) {
            case 'server':
            case 'alert':
                result = await rconApi.execute(`servermsg "${safeMessage}"`)
                break;
            default:
                // Prepend author or context since we can't truly impersonate via RCON easily
                const prefix = channel === 'admin' ? '[Admin]' : `[${authorName}]`;
                result = await rconApi.execute(`servermsg "${prefix} ${safeMessage}"`)
                break;
        }
      }

      if (result?.success) {
        // Add to local chat history (keep last 200 messages)
        // With LogTailer, this might duplicate if we are fast enough, but our dedup logic should handle it
        setChatHistory(prev => [...prev, {
          id: Date.now().toString(),
          type: channel,
          author: channel === 'general' ? authorName : 'Server',
          message: message,
          timestamp: new Date()
        }].slice(-200))
        setMessage('')
        toast({
          title: 'Message Sent',
          description: `Sent to ${channelLabel}`,
          variant: 'success' as const,
        })
      } else {
        throw new Error(result?.error || 'Failed to send message')
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to send message',
        variant: 'destructive',
      })
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const getMessageStyle = (type: ChatChannel) => {
    switch (type) {
      case 'alert':
        return 'bg-amber-500/10 border-l-4 border-amber-500 ml-4'
      case 'admin':
        return 'bg-red-500/10 border-l-4 border-red-500 ml-4'
      case 'general':
        return 'bg-blue-500/10 border-l-4 border-blue-500 ml-4'
      default:
        return 'bg-primary/10 ml-4'
    }
  }

  const getMessageIcon = (type: ChatChannel) => {
    switch (type) {
      case 'alert':
        return <Bell className="w-3 h-3 text-amber-500" />
      case 'admin':
        return <Shield className="w-3 h-3 text-red-500" />
      case 'general':
        return <MessageSquare className="w-3 h-3 text-blue-500" />
      default:
        return <Megaphone className="w-3 h-3 text-primary" />
    }
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title="In-Game Chat"
        description="Send messages to players via PanelBridge"
        icon={<MessagesSquare className="w-5 h-5" />}
        actions={
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${bridgeConnected ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'}`}>
              {bridgeLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <div className={`w-2 h-2 rounded-full ${bridgeConnected ? 'bg-emerald-500' : 'bg-red-500'}`} />
              )}
              <span className="text-sm font-medium">{bridgeConnected ? 'Bridge Connected' : 'Bridge Offline'}</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => { fetchPlayers(); checkBridgeStatus() }} className="gap-2">
              <RefreshCw className="w-4 h-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {/* Bridge Warning */}
      {!bridgeConnected && !bridgeLoading && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="flex items-center gap-4 py-4">
            <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
            <div>
              <p className="font-medium text-amber-600 dark:text-amber-400">PanelBridge Not Connected</p>
              <p className="text-sm text-muted-foreground">
                Make sure the PZ server is running and PanelBridge mod is installed. Configure in Panel Settings.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chat Window */}
        <div className="lg:col-span-2">
          <Card className="card-interactive h-[600px] flex flex-col">
            <CardHeader className="pb-3 border-b shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <MessagesSquare className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Server Chat</CardTitle>
                  <CardDescription className="mt-0.5">Send messages to players in-game</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col p-0 min-h-0">
              {/* Messages Area */}
              <ScrollArea className="flex-1 px-4">
                <div className="py-4 space-y-3">
                  {chatHistory.length === 0 ? (
                    <EmptyState type="noMessages" title="No messages yet" description="Send a message to get started" compact />
                  ) : (
                    chatHistory.map((msg) => (
                      <div
                        key={msg.id}
                        className={`p-3 rounded-lg ${getMessageStyle(msg.type)}`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            {getMessageIcon(msg.type)}
                            <span className="text-xs font-medium text-muted-foreground">
                              {msg.type === 'general' && msg.author ? msg.author : getChannelLabel(msg.type)}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {msg.timestamp.toLocaleTimeString()}
                          </span>
                        </div>
                        <p className="text-sm">{msg.message}</p>
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>
              </ScrollArea>

              {/* Message Input */}
              <div className="p-4 border-t bg-muted/30">
                <div className="flex gap-2 mb-3">
                  <Select value={channel} onValueChange={(v) => setChannel(v as ChatChannel)}>
                    <SelectTrigger className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="server">
                        <div className="flex items-center gap-2">
                          <Megaphone className="w-4 h-4" />
                          Server Chat
                        </div>
                      </SelectItem>
                      <SelectItem value="alert">
                        <div className="flex items-center gap-2">
                          <Bell className="w-4 h-4 text-amber-500" />
                          Alert (Prominent)
                        </div>
                      </SelectItem>
                      <SelectItem value="admin">
                        <div className="flex items-center gap-2">
                          <Shield className="w-4 h-4 text-red-500" />
                          Admin Only
                        </div>
                      </SelectItem>
                      <SelectItem value="general">
                        <div className="flex items-center gap-2">
                          <MessageSquare className="w-4 h-4 text-blue-500" />
                          Custom Author
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  
                  {channel === 'general' && (
                    <Input
                      placeholder="Author name..."
                      value={authorName}
                      onChange={(e) => setAuthorName(e.target.value)}
                      className="w-32"
                    />
                  )}
                </div>

                <div className="flex gap-2">
                  <Input
                    placeholder="Type your message..."
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={sending || !bridgeConnected}
                    className="flex-1"
                  />
                  <Button
                    onClick={sendMessage}
                    disabled={sending || !message.trim() || !bridgeConnected}
                    className="gap-2"
                  >
                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    Send
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Online Players */}
          <Card className="card-interactive">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                  <Users className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <CardTitle className="text-lg">Online Players</CardTitle>
                  <CardDescription>{players.length} players</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {players.length === 0 ? (
                <p className="text-sm text-muted-foreground">No players online</p>
              ) : (
                <div className="space-y-2">
                  {players.map((player) => (
                    <div key={player.name} className="flex items-center gap-2 p-2 rounded-lg bg-muted/50">
                      <div className="w-2 h-2 rounded-full bg-emerald-500" />
                      <span className="text-sm font-medium">{player.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Chat Types Info */}
          <Card className="card-interactive">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
                  <Info className="w-5 h-5 text-blue-400" />
                </div>
                <CardTitle className="text-lg">Chat Types</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="text-sm space-y-3">
              <div className="flex items-start gap-2">
                <Megaphone className="w-4 h-4 mt-0.5 text-primary shrink-0" />
                <div>
                  <strong className="text-foreground">Server Chat:</strong>
                  <span className="text-muted-foreground"> Standard message visible to all players.</span>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Bell className="w-4 h-4 mt-0.5 text-amber-500 shrink-0" />
                <div>
                  <strong className="text-foreground">Alert:</strong>
                  <span className="text-muted-foreground"> Prominent alert-style message to all.</span>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Shield className="w-4 h-4 mt-0.5 text-red-500 shrink-0" />
                <div>
                  <strong className="text-foreground">Admin Only:</strong>
                  <span className="text-muted-foreground"> Only visible to admins.</span>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <MessageSquare className="w-4 h-4 mt-0.5 text-blue-500 shrink-0" />
                <div>
                  <strong className="text-foreground">Custom Author:</strong>
                  <span className="text-muted-foreground"> Appears in general chat with your name.</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Quick Messages */}
          <Card className="card-interactive">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                  <Megaphone className="w-5 h-5 text-amber-400" />
                </div>
                <CardTitle className="text-lg">Quick Messages</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {[
                'Server will restart in 5 minutes!',
                'Welcome to the server!',
                'Please read the rules at /rules',
                'Server maintenance starting soon',
                'Have fun and stay safe!'
              ].map((quickMsg) => (
                <Button
                  key={quickMsg}
                  variant="outline"
                  size="sm"
                  className="w-full justify-start text-left h-auto py-2 px-3"
                  onClick={() => setMessage(quickMsg)}
                >
                  {quickMsg}
                </Button>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
