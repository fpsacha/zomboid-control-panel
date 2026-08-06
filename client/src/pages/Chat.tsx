import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { 
  MessagesSquare,
  Send,
  Users,
  Megaphone,
  Loader2,
  RefreshCw,
  Shield,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  Check,
  X,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { useTranslation } from 'react-i18next';
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'
import { useSocket } from '@/contexts/SocketContext'
import { EmptyState } from '@/components/EmptyState'
import { cn } from '@/lib/utils'
import { reportClientError } from '@/lib/client-errors'

interface ChatMessage {
  id: string
  type: string
  author?: string
  message: string
  timestamp: Date
}

interface Player {
  name: string
}

type ChatChannel = 'server' | 'admin' | 'general'

export default function Chat() {
  const { t } = useTranslation('chat');
  const DEFAULT_PRESETS = useMemo(() => t('defaultPresets', { returnObjects: true }) as string[], [t]);
  const [message, setMessage] = useState('')
  const [players, setPlayers] = useState<Player[]>([])
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [channel, setChannel] = useState<ChatChannel>('server')
  const [presets, setPresets] = useState<string[]>(DEFAULT_PRESETS)
  const [presetsEditing, setPresetsEditing] = useState(false)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editingDraft, setEditingDraft] = useState('')
  const [newPresetDraft, setNewPresetDraft] = useState('')

  const chatEndRef = useRef<HTMLDivElement>(null)
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
  const messageInputRef = useRef<HTMLInputElement>(null)
  const stickToBottomRef = useRef(true)
  const sendingRef = useRef(false)
  const { toast } = useToast()
  const socket = useSocket()

  // Track whether the user is parked at (or near) the bottom of the
  // scroll viewport. We only auto-scroll on new messages when they are,
  // so reading older history isn't yanked back by every incoming line.
  const handleScroll = useCallback(() => {
    const el = scrollViewportRef.current
    if (!el) return
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight)
    stickToBottomRef.current = distance < 80
  }, [])

  useEffect(() => {
    // ScrollArea (Radix) renders a viewport div with [data-radix-scroll-area-viewport].
    const root = chatEndRef.current?.closest('[data-radix-scroll-area-viewport]') as HTMLDivElement | null
    scrollViewportRef.current = root
    if (!root) return
    root.addEventListener('scroll', handleScroll, { passive: true })
    return () => root.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  useEffect(() => {
    if (stickToBottomRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [chatHistory])

  const fetchPlayers = useCallback(async () => {
    try {
      const data = await playersApi.getPlayers()
      if (data.players) {
        setPlayers(data.players)
      }
    } catch (error) {
      reportClientError('Failed to fetch players.', error)
    }
  }, [])

  useEffect(() => {
    fetchPlayers()
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      fetchPlayers()
    }, 15000)
    return () => clearInterval(interval)
  }, [fetchPlayers])

  // Listen for chat messages from the server log tailer
  useEffect(() => {
    if (socket) {
      const handleSocketMessage = (data: { id?: string; type?: string; author?: string; message?: string; timestamp?: string }) => {
        const msg = data.message
        if (!msg) return
        setChatHistory(prev => {
             // Coalesce an optimistic local post with the echoed server log line
             // without dropping a legitimate repeated chat message from a player.
             const parsedTs = data.timestamp ? Date.parse(data.timestamp) : Number.NaN
             const incomingTs = Number.isFinite(parsedTs) ? parsedTs : Date.now()
             const recent = prev.slice(-20)
             const hasSameSocketId = data.id ? recent.some(m => m.id === data.id) : false
             const isOptimisticEcho = recent.some(m =>
               m.id.startsWith('local-') &&
               m.message === msg &&
               m.author === data.author &&
               Math.abs(m.timestamp.getTime() - incomingTs) < 15000
             )
             if (hasSameSocketId || isOptimisticEcho) return prev

             const newMessage: ChatMessage = {
                id: data.id || `${incomingTs}-${Math.random().toString(36).slice(2, 8)}`,
                type: data.type || 'general',
                author: data.author,
                message: msg,
                timestamp: new Date(incomingTs)
             }

             return [...prev, newMessage].slice(-200)
        })
      }

      socket.on('chat:message', handleSocketMessage)
      return () => { socket.off('chat:message', handleSocketMessage) }
    }
  }, [socket])

  const sendMessage = async () => {
    if (!message.trim() || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    try {
      // Dispatch on the selected channel:
      //   server  → yellow broadcast banner (RCON servermsg)
      //   admin   → red admin-only chat (visible only to admins in-game)
      //   general → posts as a custom author into the public chat stream
      let result: { success?: boolean; error?: string } | undefined
      let localType: ChatMessage['type'] = 'server'
      let localAuthor: string | undefined
      if (channel === 'admin') {
        result = await panelBridgeApi.sendToAdminChat(message)
        localType = 'admin'
      } else if (channel === 'general') {
        result = await panelBridgeApi.sendToGeneralChat(message, 'Admin')
        localType = 'general'
        localAuthor = 'Admin'
      } else {
        result = await panelBridgeApi.sendToServerChat(message, false)
      }

      if (result?.success) {
        const sentAt = new Date()
        setChatHistory(prev => [...prev, {
          id: `local-${sentAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
          type: localType,
          author: localAuthor,
          message: message,
          timestamp: sentAt
        }].slice(-200))
        // Sending always pins the user back to the bottom — they just
        // posted, so they want to see the result.
        stickToBottomRef.current = true
        setMessage('')
        toast({
          title:
            channel === 'admin' ? t('toast.adminMessageSent')
            : channel === 'general' ? t('toast.postedToChat')
            : t('toast.broadcastSent'),
          description:
            channel === 'admin' ? t('toast.adminMessageSentDesc')
            : channel === 'general' ? t('toast.postedToChatDesc')
            : t('toast.broadcastSentDesc'),
          variant: 'success' as const,
        })
      } else {
        throw new Error(result?.error || t('errors.sendFailed'))
      }
    } catch (error) {
      toast({
        title: t('errors.error'),
        description: error instanceof Error ? error.message : t('errors.sendFailed'),
        variant: 'destructive',
      })
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  // Load saved chat presets from app settings; fall back to defaults.
  useEffect(() => {
    let cancelled = false
    configApi.getAppSettings()
      .then((settings: any) => {
        if (cancelled) return
        const saved = settings?.chatPresets
        if (Array.isArray(saved) && saved.every((p: unknown) => typeof p === 'string')) {
          setPresets(saved.length > 0 ? saved : DEFAULT_PRESETS)
        }
      })
      .catch(() => { /* fall back to defaults silently */ })
    return () => { cancelled = true }
  }, [DEFAULT_PRESETS])

  const persistPresets = useCallback(async (next: string[]) => {
    setPresets(next)
    try {
      await configApi.updateAppSettings({ chatPresets: next })
    } catch (error) {
      reportClientError('Failed to save chat presets.', error)
      toast({
        title: t('errors.couldNotSavePresets'),
        description: error instanceof Error ? error.message : t('errors.unknownError'),
        variant: 'destructive',
      })
    }
  }, [t, toast])

  const handleAddPreset = useCallback(() => {
    const trimmed = newPresetDraft.trim()
    if (!trimmed) return
    if (trimmed.length > 500) return
    persistPresets([...presets, trimmed])
    setNewPresetDraft('')
  }, [newPresetDraft, persistPresets, presets])

  const handleSaveEdit = useCallback(() => {
    if (editingIdx === null) return
    const trimmed = editingDraft.trim()
    if (!trimmed) return
    const next = presets.slice()
    next[editingIdx] = trimmed.slice(0, 500)
    persistPresets(next)
    setEditingIdx(null)
    setEditingDraft('')
  }, [editingDraft, editingIdx, persistPresets, presets])

  const handleDeletePreset = useCallback((idx: number) => {
    const next = presets.filter((_, i) => i !== idx)
    persistPresets(next)
    if (editingIdx === idx) {
      setEditingIdx(null)
      setEditingDraft('')
    }
  }, [editingIdx, persistPresets, presets])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const getMessageStyle = (type: string) => {
    if (type === 'server') return 'border-l-2 border-amber-400/70 bg-amber-400/5 pl-3 pr-3 py-2'
    if (type === 'admin')  return 'border-l-2 border-destructive/70 bg-destructive/5 pl-3 pr-3 py-2'
    return 'border-l-2 border-primary/55 bg-muted/15 pl-3 pr-3 py-2'
  }

  const getMessageMeta = (msg: ChatMessage) => {
    if (msg.type === 'server') return { icon: <Megaphone className="w-3 h-3" />, label: msg.author || t('labels.server'), labelClass: 'text-amber-400', dotClass: 'bg-amber-400/80' }
    if (msg.type === 'admin')  return { icon: <Shield className="w-3 h-3" />,    label: msg.author || t('labels.admin'),  labelClass: 'text-destructive', dotClass: 'bg-destructive/80' }
    return { icon: <MessageSquare className="w-3 h-3" />, label: msg.author || t('labels.player'), labelClass: 'text-primary', dotClass: 'bg-primary/80' }
  }

  return (
    <div className="space-y-6 page-transition">
      <PageHeader
        title={t("title")}
        description={t("description")}
        icon={<MessagesSquare className="w-5 h-5" />}
        actions={
          <Button variant="outline" size="sm" onClick={fetchPlayers} className="gap-2">
            <RefreshCw className="w-4 h-4" />
            {t('actions.refresh')}
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Chat Window */}
        <div className="lg:col-span-2">
          <div className="relative h-[calc(100vh-260px)] min-h-[420px] flex flex-col rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg overflow-hidden">
            {/* corner brackets */}
            <div aria-hidden className="absolute top-1 left-1 w-2.5 h-2.5 border-l-2 border-t-2 border-primary/45 pointer-events-none z-10" />
            <div aria-hidden className="absolute top-1 right-1 w-2.5 h-2.5 border-r-2 border-t-2 border-primary/45 pointer-events-none z-10" />
            <div aria-hidden className="absolute bottom-1 left-1 w-2.5 h-2.5 border-l-2 border-b-2 border-primary/45 pointer-events-none z-10" />
            <div aria-hidden className="absolute bottom-1 right-1 w-2.5 h-2.5 border-r-2 border-b-2 border-primary/45 pointer-events-none z-10" />

            {/* header strip */}
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] select-none shrink-0">
              <span className="flex items-center gap-1.5 text-primary/70">
                <MessagesSquare className="w-3 h-3" />
                <span>{t('chatStream')}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                <span className="text-muted-foreground/80 normal-case tracking-normal tabular-nums">{chatHistory.length} {chatHistory.length === 1 ? t('messageCount.msg') : t('messageCount.msgs')}</span>
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground/60">
                <span className={cn('w-1.5 h-1.5 rounded-full', socket?.connected ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground/40')} />
                <span>{socket?.connected ? t('status.live') : t('status.offline')}</span>
              </span>
            </div>

            <div className="flex-1 flex flex-col p-0 min-h-0">
              {/* Messages Area */}
              <ScrollArea className="flex-1 px-3" role="log" aria-live="polite" aria-label={t('labels.chatMessages')}>
                <div className="py-3 space-y-2">
                  {chatHistory.length === 0 ? (
                    <EmptyState type="noMessages" title={t("noMessages.title")} description={t("noMessages.description")} compact />
                  ) : (
                    chatHistory.map((msg) => {
                      const meta = getMessageMeta(msg)
                      return (
                        <div key={msg.id} className={getMessageStyle(msg.type)}>
                          <div className="flex items-center justify-between mb-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', meta.dotClass)} />
                              <span className={cn('font-mono text-[10px] uppercase tracking-[0.18em] flex items-center gap-1', meta.labelClass)}>
                                {meta.icon}
                                {meta.label}
                              </span>
                            </div>
                            <time dateTime={msg.timestamp.toISOString()} className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
                              {msg.timestamp.toLocaleTimeString()}
                            </time>
                          </div>
                          <p className="text-sm text-foreground/90 [overflow-wrap:anywhere]">{msg.message}</p>
                        </div>
                      )
                    })
                  )}
                  <div ref={chatEndRef} />
                </div>
              </ScrollArea>

              {/* Message Input */}
              <div className="p-3 border-t border-border/50 bg-muted/20">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select value={channel} onValueChange={(v) => setChannel(v as ChatChannel)} disabled={sending}>
                    <SelectTrigger className="h-10 sm:w-52 font-mono text-[11px] uppercase tracking-[0.16em] bg-card/70 border-border/55" aria-label={t('labels.chatChannel')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="server">
                        <span className="flex items-center gap-2">
                          <Megaphone className="w-3.5 h-3.5 text-amber-400" />
                          {t('channels.serverBroadcast')}
                        </span>
                      </SelectItem>
                      <SelectItem value="admin">
                        <span className="flex items-center gap-2">
                          <Shield className="w-3.5 h-3.5 text-destructive" />
                          {t('channels.adminChat')}
                        </span>
                      </SelectItem>
                      <SelectItem value="general">
                        <span className="flex items-center gap-2">
                          <MessageSquare className="w-3.5 h-3.5 text-primary" />
                          {t('channels.generalChat')}
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    ref={messageInputRef}
                    placeholder={
                      channel === 'admin'
                        ? t('placeholders.adminOnly')
                        : channel === 'general'
                          ? t('placeholders.postAsAdmin')
                          : t('placeholders.broadcast')
                    }
                    aria-label={t('labels.chatMessage')}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={sending}
                    maxLength={500}
                    className="h-10 flex-1 bg-card/70 border-border/55 focus-visible:border-primary/60"
                  />
                  <Button
                    onClick={sendMessage}
                    disabled={sending || !message.trim()}
                    className="h-10 min-w-20 sm:min-w-24 gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em]"
                  >
                    {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Send className="w-3.5 h-3.5" />{t('actions.send')}</>}
                  </Button>
                </div>
                <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/65">
                  <span>
                    {channel === 'admin'
                      ? t('placeholders.adminOnlyHidden')
                      : players.length === 0
                        ? t('status.noPlayersOnlineServerLog')
                        : t('status.broadcastingTo', { count: players.length })}
                  </span>
                  <span className={cn('tabular-nums', message.length > 450 ? 'text-amber-400' : '')}>
                    {message.length}/500
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Online Players */}
          <div className="relative rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-md overflow-hidden">
            <div aria-hidden className="absolute top-1 left-1 w-2 h-2 border-l-2 border-t-2 border-primary/40 pointer-events-none" />
            <div aria-hidden className="absolute top-1 right-1 w-2 h-2 border-r-2 border-t-2 border-primary/40 pointer-events-none" />
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] select-none">
              <span className="flex items-center gap-1.5 text-primary/70">
                <Users className="w-3 h-3" />
                <span>{t('players')}</span>
              </span>
              <span className="text-muted-foreground/70 tabular-nums normal-case tracking-normal">{t('status.online', { count: players.length })}</span>
            </div>
            <div className="p-2">
              {players.length === 0 ? (
                <div className="px-2 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60 italic">
                  {t('status.noPlayersConnected')}
                </div>
              ) : (
                <div className="space-y-1">
                  {players.map((player) => (
                    <div key={player.name} className="flex items-center gap-2 px-2 py-1.5 rounded-sm border-l-2 border-transparent hover:border-primary/50 hover:bg-muted/40 transition-colors min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 animate-pulse" aria-hidden="true" />
                      <span className="text-xs font-medium text-foreground/90 truncate">{player.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Quick Messages */}
          <div className="relative rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-md overflow-hidden">
            <div aria-hidden className="absolute top-1 left-1 w-2 h-2 border-l-2 border-t-2 border-amber-400/40 pointer-events-none" />
            <div aria-hidden className="absolute top-1 right-1 w-2 h-2 border-r-2 border-t-2 border-amber-400/40 pointer-events-none" />
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] select-none">
              <span className="flex items-center gap-1.5 text-amber-400/80">
                <Megaphone className="w-3 h-3" />
                <span>{t('quickBroadcasts')}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 -my-1 font-mono text-[10px] uppercase tracking-[0.16em]"
                onClick={() => {
                  setPresetsEditing((v) => !v)
                  setEditingIdx(null)
                  setEditingDraft('')
                  setNewPresetDraft('')
                }}
                aria-label={presetsEditing ? t('labels.doneEditingPresets') : t('labels.editPresets')}
              >
                {presetsEditing ? <><Check className="w-3 h-3 mr-1" />{t('presets.done')}</> : <><Pencil className="w-3 h-3 mr-1" />{t('presets.edit')}</>}
              </Button>
            </div>
            <div className="p-2 space-y-1.5">
              {presets.length === 0 && !presetsEditing && (
                <p className="px-2 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">{t('presets.noPresets')}</p>
              )}
              {presets.map((quickMsg, idx) => {
                const isEditing = presetsEditing && editingIdx === idx
                if (isEditing) {
                  return (
                    <div key={`edit-${idx}`} className="flex items-center gap-1">
                      <Input
                        value={editingDraft}
                        onChange={(e) => setEditingDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); handleSaveEdit() }
                          if (e.key === 'Escape') { setEditingIdx(null); setEditingDraft('') }
                        }}
                        maxLength={500}
                        autoFocus
                        className="h-9 flex-1 text-sm"
                      />
                      <Button variant="ghost" size="icon" className="h-9 w-9" onClick={handleSaveEdit} aria-label={t('labels.save')}>
                        <Check className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => { setEditingIdx(null); setEditingDraft('') }} aria-label={t('labels.cancel')}>
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  )
                }
                return (
                  <div key={`preset-${idx}`} className="flex items-center gap-1">
                    <button
                      type="button"
                      className="group flex-1 min-h-9 px-2 py-1.5 text-left rounded-sm border-l-2 border-transparent bg-muted/15 hover:border-amber-400/60 hover:bg-muted/40 focus-visible:border-amber-400/60 focus-visible:outline-none transition-colors text-xs text-foreground/85 whitespace-normal"
                      onClick={() => {
                        if (presetsEditing) {
                          setEditingIdx(idx)
                          setEditingDraft(quickMsg)
                        } else {
                          setMessage(quickMsg)
                          messageInputRef.current?.focus()
                        }
                      }}
                    >
                      {quickMsg}
                    </button>
                    {presetsEditing && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-destructive hover:text-destructive"
                        onClick={() => handleDeletePreset(idx)}
                        aria-label={`${t('labels.deletePreset')} ${idx + 1}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                )
              })}
              {presetsEditing && (
                <div className="flex items-center gap-1 pt-2 mt-1 border-t border-border/40">
                  <Input
                    placeholder={t('placeholders.newPreset')}
                    value={newPresetDraft}
                    onChange={(e) => setNewPresetDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); handleAddPreset() }
                    }}
                    maxLength={500}
                    className="h-9 flex-1 text-sm bg-card/70 border-border/55"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={handleAddPreset}
                    disabled={!newPresetDraft.trim()}
                    aria-label={t('labels.addPreset')}
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
