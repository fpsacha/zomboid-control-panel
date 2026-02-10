import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useEffect, useState, useContext } from 'react'
import { 
  LayoutDashboard, 
  Users, 
  Terminal, 
  Clock, 
  Package, 
  Settings,
  Server,
  Download,
  Bug,
  Map,
  MessageSquare,
  Layers,
  ChevronDown,
  FileCog,
  Palette,
  Menu,
  X,
  Search,
  Zap,
  MessagesSquare,
  Archive,
  AlertCircle,
  RefreshCw
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ConnectionStatus } from './ConnectionStatus'
import { serversApi, ServerInstance, updateApi, UpdateStatus } from '@/lib/api'
import { SocketContext } from '@/contexts/SocketContext'
import { useTheme } from '@/contexts/ThemeContext'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"

// Standalone top-level nav item (not collapsible)
const dashboardItem = { to: '/', icon: LayoutDashboard, label: 'Dashboard' }

// Navigation sections with collapsible groups
const navSections = [
  {
    id: 'active',
    label: 'Live',
    icon: Terminal,
    color: 'emerald',
    items: [
      { to: '/console', icon: Terminal, label: 'Server Console' },
      { to: '/players', icon: Users, label: 'Online Players' },
      { to: '/chat', icon: MessagesSquare, label: 'In-Game Chat' },
    ]
  },
  {
    id: 'world',
    label: 'World',
    icon: Zap,
    color: 'amber',
    items: [
      { to: '/events', icon: Zap, label: 'Events & Weather' },
    ]
  },
  {
    id: 'config',
    label: 'Config',
    icon: FileCog,
    color: 'blue',
    items: [
      { to: '/server-config', icon: FileCog, label: 'INI Settings' },
      { to: '/mods', icon: Package, label: 'Workshop Mods' },
    ]
  },
  {
    id: 'maintenance',
    label: 'Maintain',
    icon: Clock,
    color: 'purple',
    items: [
      { to: '/scheduler', icon: Clock, label: 'Scheduled Tasks' },
      { to: '/backups', icon: Archive, label: 'World Backups' },
      { to: '/chunks', icon: Map, label: 'Map Cleanup' },
    ]
  },
  {
    id: 'servers',
    label: 'Servers',
    icon: Server,
    color: 'cyan',
    items: [
      { to: '/servers', icon: Layers, label: 'My Servers' },
      { to: '/server-setup', icon: Download, label: 'Steam Installer' },
      { to: '/server-finder', icon: Search, label: 'Browse Public' },
    ]
  },
  {
    id: 'system',
    label: 'Settings & Tools',
    icon: Settings,
    color: 'slate',
    items: [
      { to: '/discord', icon: MessageSquare, label: 'Discord' },
      { to: '/settings', icon: Settings, label: 'Panel Settings' },
      { to: '/debug', icon: Bug, label: 'Debug Logs' },
    ]
  },
]

// Color maps for section accent dots/icons
const sectionColors: Record<string, { dot: string; icon: string; bg: string; border: string; activeBg: string }> = {
  emerald: { dot: 'bg-emerald-500', icon: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', activeBg: 'bg-emerald-500/5' },
  amber:   { dot: 'bg-amber-500',   icon: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   activeBg: 'bg-amber-500/5' },
  blue:    { dot: 'bg-blue-500',    icon: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/20',    activeBg: 'bg-blue-500/5' },
  purple:  { dot: 'bg-violet-500',  icon: 'text-violet-400',  bg: 'bg-violet-500/10',  border: 'border-violet-500/20',  activeBg: 'bg-violet-500/5' },
  cyan:    { dot: 'bg-cyan-500',    icon: 'text-cyan-400',    bg: 'bg-cyan-500/10',    border: 'border-cyan-500/20',    activeBg: 'bg-cyan-500/5' },
  slate:   { dot: 'bg-slate-400',   icon: 'text-slate-400',   bg: 'bg-slate-500/10',   border: 'border-slate-500/20',   activeBg: 'bg-slate-500/5' },
}

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const [activeServer, setActiveServer] = useState<ServerInstance | null>(null)
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['active', 'world']))
  const [updateInfo, setUpdateInfo] = useState<UpdateStatus | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [playerCount, setPlayerCount] = useState<number>(0)
  const socket = useContext(SocketContext)

  // Listen for player updates globaly
  useEffect(() => {
    if (!socket) return

    const handlePlayersUpdate = (players: any[]) => {
      setPlayerCount(players.length)
    }

    socket.on('players:update', handlePlayersUpdate)
    return () => {
      socket.off('players:update', handlePlayersUpdate)
    }
  }, [socket])
  const navigate = useNavigate()
  const location = useLocation()
  const { theme, setTheme } = useTheme()

  // Toggle section open/closed
  const toggleSection = (sectionId: string) => {
    setOpenSections(prev => {
      const newSet = new Set(prev)
      if (newSet.has(sectionId)) {
        newSet.delete(sectionId)
      } else {
        newSet.add(sectionId)
      }
      return newSet
    })
  }

  // Auto-open section containing current route
  useEffect(() => {
    const currentPath = location.pathname
    for (const section of navSections) {
      if (section.items.some(item => item.to === currentPath)) {
        setOpenSections(prev => new Set([...prev, section.id]))
        break
      }
    }
  }, [location.pathname])

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [children])

  // Fetch servers and active server
  useEffect(() => {
    const fetchServers = async () => {
      try {
        const data = await serversApi.getAll()
        setServers(data.servers || [])
        const active = data.servers?.find((s: ServerInstance) => s.isActive) || null
        setActiveServer(active)
      } catch (error) {
        console.error('Failed to fetch servers:', error)
      }
    }
    fetchServers()
  }, [])

  // Listen for server changes
  useEffect(() => {
    if (!socket) return
    
    const handleActiveServerChanged = async () => {
      try {
        const data = await serversApi.getAll()
        setServers(data.servers || [])
        const active = data.servers?.find((s: ServerInstance) => s.isActive) || null
        setActiveServer(active)
      } catch (error) {
        console.error('Failed to refresh servers:', error)
      }
    }
    
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket])

  // Listen for update notifications
  useEffect(() => {
    if (!socket) return
    
    const handleUpdateAvailable = (data: UpdateStatus) => {
      setUpdateInfo(data)
      setUpdateDismissed(false) // Show banner again when new update detected
    }
    
    const handleUpdateCheck = (data: UpdateStatus) => {
      if (data.updateAvailable) {
        setUpdateInfo(data)
      } else {
        setUpdateInfo(null)
      }
    }
    
    socket.on('server:updateAvailable', handleUpdateAvailable)
    socket.on('server:updateCheck', handleUpdateCheck)
    
    // Check for updates on mount
    updateApi.getStatus().then(status => {
      if (status.updateAvailable?.updateAvailable) {
        setUpdateInfo(status.updateAvailable)
      }
    }).catch(() => {})
    
    return () => {
      socket.off('server:updateAvailable', handleUpdateAvailable)
      socket.off('server:updateCheck', handleUpdateCheck)
    }
  }, [socket])

  const handleSwitchServer = async (server: ServerInstance) => {
    if (server.isActive) return
    try {
      await serversApi.activate(server.id)
      // Socket event will refresh the list
    } catch (error) {
      console.error('Failed to switch server:', error)
    }
  }

  return (
    <div className="flex h-screen bg-background">
      {/* Mobile Header */}
      <div className="fixed top-0 left-0 right-0 z-50 lg:hidden bg-card border-b">
        <div className="flex items-center justify-between p-3">
          <div className="flex items-center gap-2">
            <img 
              src="/spiffo.png" 
              alt="Spiffo" 
              className="w-8 h-10 object-contain"
            />
            <div>
              <h1 
                className={cn(
                  "font-bold text-sm tracking-wider",
                  theme === 'survival' ? "text-amber-500" : "text-emerald-500"
                )} 
                style={{ 
                  fontFamily: theme === 'survival' 
                    ? "'Bebas Neue', Impact, sans-serif" 
                    : "Impact, sans-serif" 
                }}
              >
                PROJECT ZOMBOID
              </h1>
              <p 
                className="text-[10px] text-muted-foreground"
                style={theme === 'survival' ? { fontFamily: "'Special Elite', monospace" } : {}}
              >
                {theme === 'survival' ? '// Control Panel' : 'Control Panel'}
              </p>
            </div>
          </div>
          <Button 
            variant="ghost" 
            size="icon"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </Button>
        </div>
      </div>

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar - Desktop always visible, Mobile as slide-out */}
      <aside className={cn(
        "fixed lg:relative inset-y-0 left-0 z-40 w-72 lg:w-64 border-r bg-card flex flex-col transform transition-transform duration-300 ease-in-out",
        "lg:translate-x-0",
        mobileMenuOpen ? "translate-x-0" : "-translate-x-full",
        "pt-16 lg:pt-0" // Add padding for mobile header
      )}>
        {/* Project Zomboid Banner with Spiffo */}
        <div className={cn(
          "relative overflow-hidden sidebar-header",
          theme === 'survival' 
            ? "bg-gradient-to-b from-amber-950/40 via-stone-950/90 to-card border-b-2 border-amber-900/30"
            : "bg-gradient-to-b from-emerald-950/40 via-zinc-950/90 to-card border-b border-emerald-900/30"
        )}>
          <div className="relative p-4">
            <div className="flex items-center gap-3 mb-2">
              {/* Spiffo - The PZ Mascot (waving Spiffo from the official wiki) */}
              <img 
                src="/spiffo.png" 
                alt="Spiffo" 
                className={cn(
                  "w-10 h-12 object-contain drop-shadow-lg",
                  theme === 'survival' && "filter saturate-90"
                )}
              />
              <div>
                <h1 
                  className={cn(
                    "font-bold text-lg tracking-widest",
                    theme === 'survival' 
                      ? "text-amber-500 text-display" 
                      : "text-emerald-500"
                  )} 
                  style={{ 
                    fontFamily: theme === 'survival' 
                      ? "'Bebas Neue', Impact, sans-serif" 
                      : "Impact, sans-serif",
                    textShadow: theme === 'survival' 
                      ? '0 2px 4px rgba(0,0,0,0.5), 0 0 20px rgba(180, 130, 50, 0.2)' 
                      : 'none'
                  }}
                >
                  PROJECT ZOMBOID
                </h1>
                <p className={cn(
                  "text-xs text-muted-foreground",
                  theme === 'survival' && "text-typewriter tracking-wide"
                )} style={theme === 'survival' ? { fontFamily: "'Special Elite', monospace" } : {}}>
                  {theme === 'survival' ? '// Control Panel' : 'Control Panel'}
                </p>
              </div>
            </div>
            
            {/* Theme Toggle */}
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/50">
              <Palette className="w-4 h-4 text-muted-foreground" />
              <div className="flex gap-1 flex-1">
                <button
                  onClick={() => setTheme('clean')}
                  className={cn(
                    "flex-1 text-xs py-1.5 px-2 rounded transition-colors",
                    theme === 'clean' 
                      ? "bg-primary text-primary-foreground" 
                      : "bg-muted/50 text-muted-foreground hover:bg-muted"
                  )}
                >
                  🌐 Modern
                </button>
                <button
                  onClick={() => setTheme('survival')}
                  className={cn(
                    "flex-1 text-xs py-1.5 px-2 rounded transition-colors",
                    theme === 'survival' 
                      ? "bg-primary text-primary-foreground" 
                      : "bg-muted/50 text-muted-foreground hover:bg-muted"
                  )}
                >
                  ☣️ Survivor
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Active Server Selector */}
        {servers.length > 0 && (
          <div className="px-4 py-3 border-b">
            <DropdownMenu>
              <DropdownMenuTrigger className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-muted/50 hover:bg-muted transition-all duration-200 text-left group border border-transparent hover:border-primary/20">
                <div className="truncate">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Active Server</p>
                  <p className="text-sm font-semibold truncate mt-0.5 group-hover:text-primary transition-colors">
                    {activeServer?.name || 'No server selected'}
                  </p>
                </div>
                <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200 group-hover:text-primary group-data-[state=open]:rotate-180" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60 glass border-border/50">
                {servers.map(server => (
                  <DropdownMenuItem
                    key={server.id}
                    onClick={() => handleSwitchServer(server)}
                    className={cn(
                      "py-2.5 px-3 cursor-pointer transition-colors",
                      server.isActive && 'bg-primary/10'
                    )}
                  >
                    <div className="flex items-center gap-3 w-full">
                      <div className={cn(
                        "w-8 h-8 rounded-lg flex items-center justify-center",
                        server.isActive ? "bg-primary/15" : "bg-muted"
                      )}>
                        <Server className={cn("w-4 h-4", server.isActive && "text-primary")} />
                      </div>
                      <span className="truncate flex-1 font-medium">{server.name}</span>
                      {server.isActive && (
                        <span className="text-xs text-primary font-semibold px-2 py-0.5 bg-primary/10 rounded-full">Active</span>
                      )}
                    </div>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate('/servers')} className="py-2.5 px-3">
                  <Layers className="w-4 h-4 mr-2" />
                  Manage Servers
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto nav-scroll">
          <div className="space-y-1">
            {/* Dashboard - standalone item */}
            <NavLink
              to={dashboardItem.to}
              onClick={() => setMobileMenuOpen(false)}
              className={({ isActive }) =>
                cn(
                  'nav-item flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group relative',
                  isActive
                    ? 'nav-item-active bg-primary/12 text-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-primary" />
                  )}
                  <span className={cn(
                    "flex items-center justify-center w-8 h-8 rounded-lg transition-colors",
                    isActive ? "bg-primary/15" : "bg-muted/50 group-hover:bg-muted"
                  )}>
                    <dashboardItem.icon className={cn("w-[18px] h-[18px]", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                  </span>
                  <span>{dashboardItem.label}</span>
                </>
              )}
            </NavLink>

            {/* Section divider */}
            <div className="pt-2" />

            {/* Collapsible sections */}
            {navSections.map((section) => {
              const colors = sectionColors[section.color] || sectionColors.slate
              const isOpen = openSections.has(section.id)
              const hasActiveChild = section.items.some(item => location.pathname === item.to)

              return (
                <Collapsible
                  key={section.id}
                  open={isOpen}
                  onOpenChange={() => toggleSection(section.id)}
                >
                  <CollapsibleTrigger className={cn(
                    "flex items-center justify-between w-full px-3 py-2 rounded-lg transition-all duration-200 group",
                    isOpen ? "mb-0.5" : "",
                    hasActiveChild && !isOpen ? colors.activeBg : "hover:bg-muted/30"
                  )}>
                    <div className="flex items-center gap-2.5">
                      <span className={cn(
                        "flex items-center justify-center w-6 h-6 rounded-md transition-colors",
                        isOpen ? cn(colors.bg, colors.border, "border") : "bg-transparent"
                      )}>
                        <section.icon className={cn(
                          "w-3.5 h-3.5 transition-colors",
                          isOpen || hasActiveChild ? colors.icon : "text-muted-foreground/60 group-hover:text-muted-foreground"
                        )} />
                      </span>
                      <span className={cn(
                        "text-xs font-semibold uppercase tracking-widest transition-colors",
                        isOpen || hasActiveChild ? "text-foreground/80" : "text-muted-foreground/60 group-hover:text-muted-foreground"
                      )}>
                        {section.label}
                      </span>
                      {hasActiveChild && !isOpen && (
                        <span className={cn("w-1.5 h-1.5 rounded-full", colors.dot)} />
                      )}
                    </div>
                    <ChevronDown className={cn(
                      "w-3.5 h-3.5 text-muted-foreground/50 transition-transform duration-200",
                      isOpen ? "" : "-rotate-90"
                    )} />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="nav-section-content overflow-hidden">
                    <div className={cn(
                      "ml-[18px] pl-3 space-y-0.5 py-0.5",
                      "border-l-[2px] transition-colors",
                      hasActiveChild ? colors.border.replace('/20', '/40') : "border-border/40"
                    )}>
                      {section.items.map((item) => (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          onClick={() => setMobileMenuOpen(false)}
                          className={({ isActive }) =>
                            cn(
                              'nav-item flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] transition-all duration-200 group relative',
                              isActive
                                ? 'nav-item-active bg-primary/10 text-foreground font-medium'
                                : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                            )
                          }
                        >
                          {({ isActive }) => (
                            <>
                              <item.icon className={cn(
                                "w-4 h-4 transition-all duration-200 shrink-0",
                                isActive ? "text-primary" : "text-muted-foreground/70 group-hover:text-foreground"
                              )} />
                              <span className="truncate">{item.label}</span>
                              {item.to === '/players' && playerCount > 0 && (
                                <span className={cn(
                                  "ml-auto text-[10px] font-bold min-w-[20px] text-center px-1.5 py-0.5 rounded-full transition-colors",
                                  isActive 
                                    ? "bg-primary/20 text-primary" 
                                    : "bg-emerald-500/10 text-emerald-400"
                                )}>
                                  {playerCount}
                                </span>
                              )}
                            </>
                          )}
                        </NavLink>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )
            })}
          </div>
        </nav>

        {/* Footer */}
        <div className="p-4 border-t space-y-4">
          <ConnectionStatus showLabel className="justify-center" />
          <div className="text-center">
            <p 
              className={cn(
                "text-xs text-muted-foreground",
                theme === 'survival' && "tracking-wide"
              )}
              style={theme === 'survival' ? { fontFamily: "'Special Elite', monospace" } : {}}
            >
              {theme === 'survival' ? '// Zomboid Control Panel' : 'Zomboid Control Panel'}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              v1.0.0 <span className={cn(
                "font-semibold ml-1 px-1.5 py-0.5 rounded",
                theme === 'survival' 
                  ? "text-amber-400 bg-amber-500/15 border border-amber-500/30" 
                  : "text-amber-500 bg-amber-500/10"
              )}>BETA</span>
            </p>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto pt-16 lg:pt-0">
        <div className="p-4 lg:p-8 max-w-7xl mx-auto">
          {/* Server Update Banner */}
          {updateInfo && updateInfo.updateAvailable && !updateDismissed && (
            <Alert className="mb-4 border-amber-500/50 bg-amber-500/10">
              <AlertCircle className="h-4 w-4 text-amber-500" />
              <AlertTitle className="text-amber-500">Server Update Available</AlertTitle>
              <AlertDescription className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  A new version is available for the <strong>{updateInfo.installed.branch}</strong> branch. 
                  Build {updateInfo.installed.buildId} → {updateInfo.latest.buildId}
                  {updateInfo.latest.description && ` (${updateInfo.latest.description})`}
                </span>
                <div className="flex gap-2 ml-4">
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => setUpdateDismissed(true)}
                  >
                    Dismiss
                  </Button>
                  <Button 
                    size="sm"
                    onClick={() => navigate('/servers')}
                    className="bg-amber-500 hover:bg-amber-600 text-white"
                  >
                    <RefreshCw className="w-4 h-4 mr-1" />
                    Update Server
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          {children}
        </div>
      </main>
    </div>
  )
}
