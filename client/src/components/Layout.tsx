import { NavLink, useLocation } from 'react-router-dom'
import { useEffect, useState, useContext } from 'react'
import { 
  Gauge,
  Users, 
  Terminal, 
  Clock, 
  Package, 
  Settings,
  Server,
  Download,
  Bug,
  Map,
  Eraser,
  MessageSquare,
  Layers,
  FileCog,
  Menu,
  X,
  Search,
  Zap,
  MessagesSquare,
  Archive,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ServerInstance } from '@/lib/api'
import { SocketContext } from '@/contexts/SocketContext'

import { Button } from "@/components/ui/button"
import { useTranslation } from 'react-i18next'
import { LanguageSwitcher } from './LanguageSwitcher'

// Standalone top-level nav item (not collapsible)
const dashboardItem = { to: '/', icon: Gauge, labelKey: 'dashboard' }



// Helper to get translated nav sections
function useTranslatedNavSections() {
  const { t } = useTranslation('nav')
  return [
    {
      id: 'active',
      label: t('sections.live'),
      icon: Terminal,
      color: 'emerald',
      items: [
        { to: '/console', icon: Terminal, labelKey: 'console' },
        { to: '/players', icon: Users, labelKey: 'players' },
        { to: '/chat', icon: MessagesSquare, labelKey: 'chat' },
      ]
    },
    {
      id: 'world',
      label: t('sections.world'),
      icon: Zap,
      color: 'amber',
      items: [
        { to: '/events', icon: Zap, labelKey: 'events' },
        { to: '/world-map', icon: Map, labelKey: 'worldMap' },
      ]
    },
    {
      id: 'config',
      label: t('sections.config'),
      icon: FileCog,
      color: 'blue',
      items: [
        { to: '/server-config', icon: FileCog, labelKey: 'serverConfig', requiresLocal: true },
        { to: '/mods', icon: Package, labelKey: 'mods', requiresLocal: true },
      ]
    },
    {
      id: 'maintenance',
      label: t('sections.maintain'),
      icon: Clock,
      color: 'purple',
      items: [
        { to: '/scheduler', icon: Clock, labelKey: 'scheduler' },
        { to: '/backups', icon: Archive, labelKey: 'backups', requiresLocal: true },
        { to: '/chunks', icon: Eraser, labelKey: 'chunks', requiresLocal: true },
      ]
    },
    {
      id: 'servers',
      label: t('sections.servers'),
      icon: Server,
      color: 'cyan',
      items: [
        { to: '/servers', icon: Layers, labelKey: 'myServers' },
        { to: '/server-setup', icon: Download, labelKey: 'serverSetup' },
        { to: '/server-finder', icon: Search, labelKey: 'browsePublic' },
      ]
    },
    {
      id: 'system',
      label: t('sections.system'),
      icon: Settings,
      color: 'slate',
      items: [
        { to: '/discord', icon: MessageSquare, labelKey: 'discord' },
        { to: '/settings', icon: Settings, labelKey: 'settings' },
        { to: '/debug', icon: Bug, labelKey: 'debug' },
      ]
    },
  ]
}

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const { t } = useTranslation('nav')
  const [activeServer] = useState<ServerInstance | null>(null)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [sidebarCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === 'true')
  
  const socket = useContext(SocketContext)
  const location = useLocation()
  const translatedNavSections = useTranslatedNavSections()

  // Listen for player updates globally
  useEffect(() => {
    if (!socket) return

    const handlePlayersUpdate = (_players: unknown) => {
      // Player count updated
    }

    socket.on('players:update', handlePlayersUpdate)
    return () => {
      socket.off('players:update', handlePlayersUpdate)
    }
  }, [socket])

  // Toggle sidebar collapse

  return (
    <div className="flex h-screen bg-background">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:text-sm">{t('skipToContent')}</a>
      
      {/* Mobile Header */}
      <div className="fixed top-0 left-0 right-0 z-50 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85 lg:hidden">
        <div className="flex items-center justify-between p-3">
          <div className="flex items-center gap-2">
            <img
              src={`${import.meta.env.BASE_URL}spiffo.png`}
              alt="Spiffo"
              className="h-8 w-8 rounded-lg"
            />
            <span className="text-sm font-semibold">{t('appName')}</span>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <Button 
              variant="ghost" 
              size="icon"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? t('common:accessibility.closeMenu') : t('common:accessibility.openMenu')}
              className="h-11 w-11 rounded-lg border border-transparent hover:border-border/70"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px] lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar - Desktop always visible, Mobile as slide-out */}
      <aside
        aria-label={t('common:accessibility.sidebar')}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex flex-col border-r bg-card transform transition-all duration-300 ease-out will-change-[width,transform] motion-reduce:transition-none lg:relative",
          sidebarCollapsed ? "lg:w-[60px]" : "lg:w-64",
          "w-72",
          "lg:translate-x-0",
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full",
          "pt-16 lg:pt-0"
        )}
      >
        {/* Brand strip */}
        <div className="border-b border-border/50 p-2">
          <div className={cn("flex items-center", sidebarCollapsed ? "justify-center" : "gap-2")}>
            <img
              src={`${import.meta.env.BASE_URL}spiffo.png`}
              alt="Spiffo"
              className={cn("rounded-lg", sidebarCollapsed ? "h-8 w-8" : "h-10 w-10")}
            />
            {!sidebarCollapsed && (
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-semibold truncate">{t('appName')}</span>
              </div>
            )}
          </div>
        </div>

        {/* Navigation */}
        <nav aria-label={t('common:accessibility.mainNavigation')} className="flex-1 overflow-y-auto px-2 py-2">
          {/* Dashboard item */}
          <NavLink
            to={dashboardItem.to}
            onClick={() => setMobileMenuOpen(false)}
            className={cn(
              'group relative flex min-h-9 items-center rounded-md px-2 py-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
              sidebarCollapsed && 'justify-center',
              location.pathname === dashboardItem.to
                ? 'bg-primary/10 text-primary'
                : 'text-foreground/86 hover:bg-muted/50 hover:text-foreground'
            )}
          >
            <dashboardItem.icon className={cn("h-4 w-4 shrink-0", sidebarCollapsed ? "mx-auto" : "mr-2")} />
            {!sidebarCollapsed && <span className="text-sm">{t(dashboardItem.labelKey)}</span>}
          </NavLink>

          {/* Sections */}
          {translatedNavSections.map((section, sectionIdx) => (
            <div key={section.id} className={cn('mt-2 pt-2 border-t border-border/40', sectionIdx === 0 && 'mt-0 pt-0 border-t-0')}>
              {!sidebarCollapsed && (
                <div className="px-2 py-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {section.label}
                  </span>
                </div>
              )}
              {section.items.map((item) => {
                const isDisabledByRemote = !!item.requiresLocal && activeServer?.isRemote
                if (isDisabledByRemote) return null
                const isActive = location.pathname === item.to
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileMenuOpen(false)}
                    className={cn(
                      'group relative flex min-h-9 items-center rounded-md px-2 py-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                      sidebarCollapsed && 'justify-center',
                      isActive
                        ? 'bg-primary/10 text-primary'
                        : 'text-foreground/86 hover:bg-muted/50'
                    )}
                  >
                    <item.icon className={cn("h-4 w-4 shrink-0", isActive ? "text-primary" : "text-foreground/86")} />
                    {!sidebarCollapsed && (
                      <span className={cn("ml-2 text-sm", isActive ? "text-primary" : "")}>{t(item.labelKey)}</span>
                    )}
                  </NavLink>
                )
              })}
            </div>
          ))}
        </nav>

        {/* Bottom controls */}
        <div className="border-t border-border/50 p-2">
          <LanguageSwitcher />
        </div>
      </aside>

      {/* Main Content */}
      <main id="main-content" className="flex-1 overflow-auto pt-16 lg:pt-0">
        <div className="p-4 lg:p-8 max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  )
}
