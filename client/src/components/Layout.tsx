import { Link, NavLink, useLocation } from 'react-router-dom'
import { useCallback, useEffect, useRef, useState, useContext } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import {
  Server,
  Layers,
  ChevronDown,
  Menu,
  X,
  Search,
  AlertCircle,
  RefreshCw,
  Github,
  PanelLeftClose,
  PanelLeft,
  LogOut,
  Plus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  NAV_SECTIONS,
  getActiveSidebarRoute,
  getRouteMeta,
  routeAvailability,
  type NavSection,
  type RouteMeta,
} from '@/lib/navigation'
import { useConfirmLeave, useGuardedNavigate } from '@/contexts/UnsavedChangesContext'
import { CommandPalette } from './CommandPalette'
import { ConnectionStatus, ConnectionAnnouncer } from './ConnectionStatus'
import { SystemHealthBanner } from './SystemHealthBanner'
import { serversApi, ServerInstance, updateApi, UpdateStatus, serverApi, modsApi, panelUpdateApi } from '@/lib/api'
import { isStatusEventForServer, resolveClientProvider } from '@/lib/serverStatus'
import { getResultErrorMessage } from '@/lib/errorMessage'
import { modUpdatesOnServer } from '@/lib/modsShared'
import { readStored, writeStored } from '@/lib/safeStorage'
import { SocketContext } from '@/contexts/SocketContext'

import { useAuth } from '@/contexts/AuthContext'
import { useToast } from '@/components/ui/use-toast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { modKeyLabel, useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp'
import { preloadRouteModule } from '@/lib/routePreload'
import { LanguageSwitcher } from './LanguageSwitcher'
import { KofiCup } from './KofiCup'
import { KOFI_URL } from '@/lib/supportLinks'

// The sidebar's structure, labels, icons and gates all come from the route
// registry (lib/navigation.ts): SERVER (the server in the strip above),
// PLAYERS, WORLD and PANEL. Each section keeps one accent colour.
const ACCENT_STYLES = {
  primary: {
    rowActive: 'border-primary/45 bg-primary/10',
    bar: 'bg-primary',
    iconActive: 'text-primary',
    label: 'text-primary',
  },
  success: {
    rowActive: 'border-success/45 bg-success/10',
    bar: 'bg-success',
    iconActive: 'text-success',
    label: 'text-success',
  },
  warning: {
    rowActive: 'border-warning/45 bg-warning/10',
    bar: 'bg-warning',
    iconActive: 'text-warning',
    label: 'text-warning',
  },
  muted: {
    rowActive: 'border-border/80 bg-muted/60',
    bar: 'bg-muted-foreground',
    iconActive: 'text-foreground',
    label: 'text-muted-foreground',
  },
} as const satisfies Record<NavSection['accent'], Record<string, string>>

const DASHBOARD_ROUTE = getRouteMeta('/') as RouteMeta

// Auth footer — shows logged-in user and logout button
// One size for every icon control in the sidebar footer, so the account row
// and the toolbar row line up and each target stays comfortably tappable.
// Same idle colour and warm hover as the nav rows.
const FOOTER_ICON_BUTTON =
  'grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

function AuthFooter({ onSignOut }: { onSignOut: () => void }) {
  const { t } = useTranslation('shell')
  const { user, authEnabled } = useAuth()

  if (!authEnabled || !user) return null

  // The footer's account row: who is signed in, and the way out at the far
  // edge. The monogram anchors the row; the name truncates before the
  // button does.
  return (
    <div className="flex min-h-7 items-center gap-2">
      <span
        aria-hidden="true"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border/40 bg-muted/40 font-mono text-[11px] font-semibold uppercase text-foreground/80"
      >
        {user.username.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/85" title={user.username}>
        {user.username}
      </span>
      <button
        type="button"
        onClick={onSignOut}
        className={FOOTER_ICON_BUTTON}
        aria-label={t('footer.signOut')}
        title={t('footer.signOut')}
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

// Tap-to-open touch fix for a disabled nav row's reason tooltip --
// impeccable-critique-2026-08-31: Radix's TooltipTrigger closes on its own
// click handler by default (built for hover, where a click is a dismiss
// gesture), which is useless for touch: there's no hover to open it in the
// first place. HelpTip.tsx already solved this exact problem (see its own
// comment) with a controlled `open` state + preventDefault() on click to
// block Radix's built-in close so the same tap opens it instead. A disabled
// nav row has no navigation for a tap to conflict with, so the same fix is
// free here -- unlike the enabled NavLink row below it, whose tap must keep
// navigating and is deliberately NOT wrapped in this.
function DisabledNavTooltip({ side = 'right', reason, children }: {
  side?: 'top' | 'right' | 'bottom' | 'left'
  reason: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild onClick={(event) => { event.preventDefault(); setOpen(true) }}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side}>{reason}</TooltipContent>
    </Tooltip>
  )
}

// Tailwind's lg breakpoint: where the sidebar is a fixed column that can
// collapse to an icon rail. jsdom has no matchMedia; that counts as lg.
const LG_QUERY = '(min-width: 1024px)'

function useIsLg(): boolean {
  const [isLg, setIsLg] = useState(() => typeof window.matchMedia !== 'function' || window.matchMedia(LG_QUERY).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(LG_QUERY)
    const update = () => setIsLg(mq.matches)
    update()
    mq.addEventListener?.('change', update)
    return () => mq.removeEventListener?.('change', update)
  }, [])
  return isLg
}

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const { t } = useTranslation('shell')
  const { t: tScheduler } = useTranslation('scheduler')
  const { t: tMods } = useTranslation('mods')
  const [activeServer, setActiveServer] = useState<ServerInstance | null>(null)

  const provider = resolveClientProvider(activeServer)
  // null = we don't yet know (still loading, or the last fetch failed) — distinct
  // from [] (fetch succeeded and confirmed there really are zero servers). Collapsing
  // those into one empty array made a slow/failed fetch render the same "no server
  // yet" claim as a genuinely empty roster, on every load and permanently on failure.
  const [servers, setServers] = useState<ServerInstance[] | null>(null)
  const serversConfirmedEmpty = servers !== null && servers.length === 0
  const { can, user, authEnabled, logout } = useAuth()
  // Same rule as the command palette: hidden without the capability,
  // disabled (with the reason) without a server or a local one.
  const availabilityOf = (route: RouteMeta) => routeAvailability(route, { can, serversConfirmedEmpty, activeServer })
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  // Not a Radix primitive, so it gets none of Radix's automatic focus
  // trap/restore -- handled manually below.
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)
  const mobileMenuAsideRef = useRef<HTMLElement>(null)
  const [sidebarCollapsedPref, setSidebarCollapsed] = useState(() => readStored('sidebarCollapsed') === 'true')
  // The icon rail is a desktop layout. Below lg the sidebar is the slide-out
  // drawer, which has no expand button, so a rail saved on desktop must not
  // follow the window down to a tablet or phone.
  const isLg = useIsLg()
  const sidebarCollapsed = isLg && sidebarCollapsedPref
  const [updateInfo, setUpdateInfo] = useState<UpdateStatus | null>(null)
  // Persist dismissal across reloads, but key it by build IDs so a NEW update
  // re-shows the banner. Was sessionStorage which got cleared on browser restart.
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [playerCount, setPlayerCount] = useState<number>(0)
  const [serverRunState, setServerRunState] = useState<'unknown' | 'running' | 'stopped' | 'transitioning' | 'unresponsive'>('unknown')
  const [modUpdatesAvailable, setModUpdatesAvailable] = useState<number>(0)
  const [panelUpdateAvailable, setPanelUpdateAvailable] = useState<{ version: string | null } | null>(null)
  const [panelVersion, setPanelVersion] = useState('')
  // The server's version, else this build's, so the footer never shows "v—".
  const displayVersion = panelVersion || (typeof __PANEL_VERSION__ !== 'undefined' ? __PANEL_VERSION__ : '')
  const socket = useContext(SocketContext)
  const { toast } = useToast()
  const { helpOpen, setHelpOpen, paletteOpen, setPaletteOpen, shortcuts } = useKeyboardShortcuts()
  const guardedNavigate = useGuardedNavigate()
  const confirmLeave = useConfirmLeave()
  const navRef = useRef<HTMLElement>(null)

  // Signing out drops the page as surely as leaving it (the sign-in screen
  // replaces the app without a reload, so no beforeunload either): ask
  // first when a page holds unsaved edits, like a sidebar link does.
  const handleSignOut = useCallback(async () => {
    if (!(await confirmLeave())) return
    await logout()
  }, [confirmLeave, logout])

  // Fetch panel version
  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then(r => r.json())
      .then(d => { if (!cancelled && d.version) setPanelVersion(d.version) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Listen for player updates globally
  useEffect(() => {
    if (!socket) return

    const handlePlayersUpdate = (players: unknown) => {
      setPlayerCount(Array.isArray(players) ? players.length : 0)
    }

    socket.on('players:update', handlePlayersUpdate)
    return () => {
      socket.off('players:update', handlePlayersUpdate)
    }
  }, [socket])

  // Surface the REAL outcome of a manual restart or "Run now" task, from
  // wherever the user happens to be -- not just on the Scheduler page.
  // POST /restart-now and /tasks/:id/run only ever confirmed the action was
  // ACCEPTED (both run in the background and used to report success:true
  // unconditionally); this is the one place the actual result reaches the
  // client at all instead of only being discoverable by someone who thinks
  // to go check Schedule History (2026-08-26 bug hunt, scheduler
  // blind-success family). Global, not page-scoped, because a restart's
  // countdown + graceful shutdown can run long enough that the user has
  // already navigated elsewhere by the time it resolves.
  //
  // A failure can carry a registered error code and its params (the server's
  // codedActionResultFields(), today SERVER_START_SCRIPT_MISSING and
  // SERVER_RESTART_SCRIPT_MISSING from GH #167, and SERVER_START_GAME_PORT_IN_USE),
  // shown translated like POST /api/server/start's own refusal; the English
  // message is the fallback.
  useEffect(() => {
    if (!socket) return
    // serverName: a restart of a server other than the active one, from the
    // Dashboard's list of servers (POST /servers/:id/restart).
    const onActionResult = (data?: { kind?: 'restart' | 'task'; taskName?: string; serverName?: string; success?: boolean; message?: string; code?: string; params?: unknown }) => {
      if (!data) return
      const isRestart = data.kind === 'restart'
      const title = isRestart && data.serverName
        ? tScheduler(data.success ? 'toasts.serverRestartSucceededTitle' : 'toasts.serverRestartFailedTitle', { name: data.serverName })
        : data.success
          ? (isRestart ? tScheduler('toasts.restartSucceededTitle') : tScheduler('toasts.taskSucceededTitle', { name: data.taskName }))
          : (isRestart ? tScheduler('toasts.restartResultFailedTitle') : tScheduler('toasts.taskResultFailedTitle', { name: data.taskName }))
      toast({
        title,
        description: !data.success && data.code
          ? getResultErrorMessage({ code: data.code, params: data.params, error: data.message }, data.message ?? '')
          : data.message,
        variant: data.success ? ('success' as const) : 'destructive',
      })
    }
    socket.on('scheduler:action_result', onActionResult)
    return () => {
      socket.off('scheduler:action_result', onActionResult)
    }
  }, [socket, tScheduler, toast])

  // GH #189: a mod-update restart that was waiting for players ends when the
  // server is started again after the update (the new start loaded the
  // updated mods). Global like the restart result above: the operator
  // usually restarted from the Dashboard, not the Mods page, and this says
  // why the pending restart they were told about won't happen. An operator's
  // own Cancel on the Mods page carries no reason and stays silent here.
  useEffect(() => {
    if (!socket) return
    const onRestartCancelled = (data?: { reason?: string }) => {
      if (data?.reason !== 'server_restarted') return
      toast({
        title: tMods('restartPending.cancelledByRestartTitle'),
        description: tMods('restartPending.cancelledByRestartDesc'),
      })
    }
    socket.on('mods:restart_cancelled', onRestartCancelled)
    return () => {
      socket.off('mods:restart_cancelled', onRestartCancelled)
    }
  }, [socket, tMods, toast])

  const location = useLocation()
  const currentRoute = getRouteMeta(location.pathname)
  // The row lit for this page: its own, or the one that lists it in
  // activeFor (Servers on Add a Server). Settings stays lit on every tab.
  const activeRoutePath = getActiveSidebarRoute(location.pathname)?.path
  const currentTitle = currentRoute ? t(currentRoute.titleKey) : null
  // The roster only moves on players:update, which stops when the server does,
  // so a stopped (or not yet confirmed) server kept its last count on the
  // Players badge. The count is shown only while the server is running, as the
  // sidebar's active-server strip already did.
  const shownPlayerCount = serverRunState === 'running' ? playerCount : 0
  const playerCountLabel = shownPlayerCount > 99 ? '99+' : String(shownPlayerCount)

  // "Title · Server · Zomboid Control Panel": the tab says which page of
  // which server, so two panel tabs stay apart.
  useEffect(() => {
    document.title = [currentTitle, activeServer?.name, t('brand.documentTitle')].filter(Boolean).join(' · ')
  }, [currentTitle, activeServer?.name, t])

  // Keep the lit row on screen: the sidebar scrolls at 900px tall, and a
  // shortcut or the palette can land on a row below the fold.
  // Again after the next frame and after the rail/drawer transition (300ms),
  // which change the nav's height and rows under it.
  useEffect(() => {
    const scrollActiveRow = () =>
      navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' })
    scrollActiveRow()
    const frame = requestAnimationFrame(scrollActiveRow)
    const afterTransition = window.setTimeout(scrollActiveRow, 350)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(afterTransition)
    }
  }, [activeRoutePath, sidebarCollapsed, mobileMenuOpen])

  // Toggle sidebar collapse
  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev
      writeStored('sidebarCollapsed', String(next))
      return next
    })
  }

  // Track server run state for the status dot on the Active Server card.
  //
  // GH#114: status.running (from serverApi.getStatus(), and the raw payload
  // pushed on the 'server:status' socket event) is a LOCAL process scan --
  // it can only ever see a process on/in this host/container. That's a
  // trustworthy, freshest signal for a native server, but a docker-managed
  // server's PZ process runs in a *different* container the scan can't see
  // at all, and a remote-sftp server isn't on this host to begin with. This
  // dot used to trust the raw scan unconditionally for every provider (not
  // even gated on isRemote, unlike the Dashboard's equivalent bug) -- a
  // Docker container correctly shown running by the Docker panel could
  // still read "stopped" here, in the sidebar, on every single page.
  // Non-native providers now read the provider-aware composed status
  // instead (server/utils/serverStatusModel.js's 3-signal model), the same
  // source Dashboard.tsx and Servers.tsx's active-server card already use.
  const refreshServerRunState = useCallback(async () => {
    if (provider === 'native') {
      try {
        const data = await serverApi.getStatus() as { running?: boolean; scanFailed?: boolean } | undefined
        // scanFailed (serverManager.js's getServerStatus(), same field
        // Dashboard.tsx's deriveDashboardStatus already excludes for this
        // exact reason) means the scan itself couldn't tell, not that it
        // confirmed stopped -- this dot used to collapse that into a
        // confident 'stopped' in the sidebar, on every page (2026-09-08
        // three-state audit).
        if (data?.scanFailed) { setServerRunState('unknown'); return }
        if (typeof data?.running === 'boolean') setServerRunState(data.running ? 'running' : 'stopped')
      } catch { /* transient fetch failure -- keep the last known state */ }
      return
    }
    if (provider == null) { setServerRunState('unknown'); return }
    try {
      const composed = await serversApi.getComposedStatus()
      const hostRunning = composed.host.status === 'running'
      const rconConnected = composed.server.status === 'connected'
      const bridgeActive = composed.bridge.status === 'active'
      const hostUnknown = ['unknown', 'not-applicable'].includes(composed.host.status)
      setServerRunState(
        hostRunning || rconConnected || bridgeActive ? 'running' : hostUnknown ? 'unknown' : 'stopped',
      )
    } catch {
      setServerRunState('unknown')
    }
  }, [provider])

  useEffect(() => {
    // Depends on activeServer?.id (not just refreshServerRunState) so
    // switching between two servers with the SAME provider -- native to
    // native, say -- still refetches; provider alone wouldn't change in
    // that case. No stale-response guard: a slower in-flight request
    // landing after a newer one could briefly overwrite it with an older
    // value, the same tolerance the previous version of this effect had.
    // Acceptable for a sidebar dot that self-corrects on the next
    // poll/socket event.
    void refreshServerRunState()
  }, [activeServer?.id, refreshServerRunState])

  useEffect(() => {
    if (!socket) return
    const onStatus = (data?: {
      running?: boolean
      isRunning?: boolean
      phase?: 'starting' | 'running' | 'stopped' | 'unresponsive' | 'unknown'
      // Set by a scheduled restart of one particular server (scheduler.js),
      // which need not be the active one this dot shows.
      serverId?: string | number | null
    }) => {
      if (!isStatusEventForServer(data, activeServer?.id)) return
      // Fast path: for a native server, a pushed boolean is as trustworthy
      // as a fresh fetch and avoids a round trip. Everything else needs the
      // composed status to know what the push actually means.
      if (provider === 'native') {
        // `phase` refines the raw boolean for exactly the window a bare
        // running:true used to lie about (host process up, RCON not
        // connected yet -- 2026-09-07, the "STARTING state" gap). Source of
        // truth: resolveServerPhase() in server/utils/serverStatus.js.
        // Display-only -- it never gates anything, only which dot/label
        // renders. Falls back to the plain boolean when phase is absent.
        if (data?.phase === 'starting') { setServerRunState('transitioning'); return }
        if (data?.phase === 'unresponsive') { setServerRunState('unresponsive'); return }
        const running = typeof data?.running === 'boolean' ? data.running : data?.isRunning
        if (typeof running === 'boolean') { setServerRunState(running ? 'running' : 'stopped'); return }
      }
      void refreshServerRunState()
    }
    socket.on('server:status', onStatus)
    return () => { socket.off('server:status', onStatus) }
  }, [socket, provider, refreshServerRunState, activeServer?.id])

  // Track mod updates available count for Mod Manager nav badge
  useEffect(() => {
    let cancelled = false
    const refreshModStatus = async () => {
      try {
        // The updates of the items the server loads, as the Mods page's
        // Installed counts show (a Deactivated item's update is not one).
        const count = modUpdatesOnServer(await modsApi.getStatus() as { updatesAvailable?: number; updatesOnServer?: number } | undefined)
        if (!cancelled && count !== null) {
          setModUpdatesAvailable(count)
        }
      } catch {
        // ignore — likely 503 / not running
      }
    }
    refreshModStatus()
    if (!socket) return () => { cancelled = true }
    socket.on('mods:updates_available', refreshModStatus)
    socket.on('mods:update_detected', refreshModStatus)
    return () => {
      cancelled = true
      socket.off('mods:updates_available', refreshModStatus)
      socket.off('mods:update_detected', refreshModStatus)
    }
  }, [socket, activeServer?.id])

  // Track panel self-update availability (separate from PZ server update)
  useEffect(() => {
    let cancelled = false
    panelUpdateApi.getStatus()
      .then(s => {
        if (cancelled) return
        if (s?.updateAvailable) setPanelUpdateAvailable({ version: s.latestVersion })
        else setPanelUpdateAvailable(null)
      })
      .catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [])

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location.pathname])

  // Close mobile menu with Escape for keyboard users, restoring focus to
  // the trigger button -- an explicit dismissal, unlike the route-change
  // effect above (there, focus should follow the navigation, not jump
  // backwards to a button on the page the user just left).
  useEffect(() => {
    if (!mobileMenuOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      // A popover or menu inside the drawer handles its own Escape (Radix
      // marks it defaultPrevented); only the next one closes the drawer.
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setMobileMenuOpen(false)
        mobileMenuButtonRef.current?.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mobileMenuOpen])

  // Move focus into the drawer when it opens -- this is a hand-rolled
  // overlay (not a Radix Dialog), so it gets none of Radix's automatic
  // focus trap. Without this, opening the menu leaves keyboard focus on
  // the trigger button, behind the now-open drawer.
  useEffect(() => {
    if (!mobileMenuOpen) return
    const firstFocusable = mobileMenuAsideRef.current?.querySelector<HTMLElement>(
      'a[href], button:not([disabled])'
    )
    firstFocusable?.focus()
  }, [mobileMenuOpen])

  // Prevent background scroll while mobile menu is open
  useEffect(() => {
    const { body } = document
    const previousOverflow = body.style.overflow
    if (mobileMenuOpen) {
      body.style.overflow = 'hidden'
    }

    return () => {
      body.style.overflow = previousOverflow
    }
  }, [mobileMenuOpen])

  // Each local server's running state for the switcher, read when it opens
  // with two servers or more (GET /servers/status, one process scan for
  // all). One server: nothing to read, the strip above already says it.
  const [switcherStates, setSwitcherStates] = useState<Record<string, boolean>>({})
  const loadSwitcherStates = useCallback(async () => {
    if ((servers?.length ?? 0) < 2) return
    try {
      const data = await serversApi.getStatus()
      const next: Record<string, boolean> = {}
      for (const row of data?.servers ?? []) {
        if (!row.stateUnknown) next[String(row.id)] = Boolean(row.running)
      }
      setSwitcherStates(next)
    } catch {
      // No dots rather than wrong ones.
    }
  }, [servers?.length])

  // Fetch servers and active server
  useEffect(() => {
    const fetchServers = async () => {
      try {
        const data = await serversApi.getAll()
        setServers(data.servers || [])
        const active = data.servers?.find((s: ServerInstance) => s.isActive) || null
        setActiveServer(active)
      } catch {
        toast({
          title: t('serverListErrors.listUnavailableTitle'),
          description: t('serverListErrors.listUnavailableDesc'),
          variant: 'destructive',
        })
      }
    }
    fetchServers()
  }, [toast, t])

  // Listen for server changes
  useEffect(() => {
    if (!socket) return

    const handleActiveServerChanged = async () => {
      // The count is the previous server's until its roster arrives.
      setPlayerCount(0)
      try {
        const data = await serversApi.getAll()
        setServers(data.servers || [])
        const active = data.servers?.find((s: ServerInstance) => s.isActive) || null
        setActiveServer(active)
      } catch {
        toast({
          title: t('serverListErrors.refreshFailedTitle'),
          description: t('serverListErrors.refreshFailedDesc'),
          variant: 'destructive',
        })
      }
    }

    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, toast, t])

  // Listen for update notifications
  useEffect(() => {
    if (!socket) return

    const handleUpdateAvailable = (data: UpdateStatus) => {
      setUpdateInfo(data)
      // Show banner again when a different update is detected
      const dismissedKey = data?.installed && data?.latest
        ? `updateBannerDismissed:${data.installed.buildId}->${data.latest.buildId}`
        : null
      setUpdateDismissed(!!dismissedKey && readStored(dismissedKey) === 'true')
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

  // POST /servers/:id/activate needs servers.manage: without it the strip
  // and the palette show the other servers but can't switch to them (a
  // click used to end in a bare "Switch failed").
  const canSwitchServer = can('servers.manage')
  const switchDeniedReason = canSwitchServer ? undefined : t('servers:card.noPermissionManage')

  const handleSwitchServer = useCallback(async (server: ServerInstance) => {
    if (server.isActive || !canSwitchServer) return
    try {
      await serversApi.activate(server.id)
      // Socket event will refresh the list
    } catch {
      toast({
        title: t('serverListErrors.switchFailedTitle'),
        description: t('serverListErrors.switchFailedDesc', { name: server.name }),
        variant: 'destructive',
      })
    }
  }, [canSwitchServer, t, toast])

  const openPalette = useCallback(() => {
    setMobileMenuOpen(false)
    setPaletteOpen(true)
  }, [setPaletteOpen])
  const showShortcuts = useCallback(() => setHelpOpen(true), [setHelpOpen])
  const modKey = modKeyLabel()

  const serverStateLabel = {
    running: t('activeServer.statusRunning'),
    stopped: t('activeServer.statusStopped'),
    transitioning: t('activeServer.statusTransitioning'),
    unresponsive: t('activeServer.statusUnresponsive'),
    unknown: t('activeServer.statusUnknown'),
  }[serverRunState]

  // The count or dot a row carries: players online, mod updates, a panel update.
  const rowBadge = (route: RouteMeta, active: boolean) => {
    if (route.path === '/players' && shownPlayerCount > 0) {
      return (
        <Badge
          variant={active ? 'secondary' : 'success'}
          className="ms-auto min-w-[24px] justify-center px-1.5 py-0 text-[10px] leading-tight"
        >
          {playerCountLabel}
        </Badge>
      )
    }
    if (route.path === '/mods' && modUpdatesAvailable > 0) {
      return (
        <Badge
          variant="warning"
          className="ms-auto min-w-[24px] justify-center px-1.5 py-0 text-[10px] leading-tight"
          title={t('modBadge.updatesAvailable', { count: modUpdatesAvailable })}
        >
          {modUpdatesAvailable > 99 ? '99+' : modUpdatesAvailable}
        </Badge>
      )
    }
    if (route.path === '/settings' && panelUpdateAvailable) {
      return (
        <span
          className="ms-auto h-1.5 w-1.5 rounded-full bg-warning motion-safe:animate-pulse"
          title={panelUpdateAvailable.version
            ? t('panelUpdateBadge.titleWithVersion', { version: panelUpdateAvailable.version })
            : t('panelUpdateBadge.titleNoVersion')}
          aria-hidden
        />
      )
    }
    return null
  }

  const preload = (route: RouteMeta) => () => preloadRouteModule(route.path)

  // One sidebar row. Expanded: icon and short label. Rail: the icon, named
  // and tooltipped with the page's full title. A row that needs a server (or
  // a local one) stays visible but inert, with the reason.
  const renderRow = (route: RouteMeta, accent: NavSection['accent']) => {
    const availability = availabilityOf(route)
    if (availability.state === 'hidden') return null
    const tone = ACCENT_STYLES[accent]
    const Icon = route.icon
    const label = t(route.labelKey)
    const fullTitle = t(route.titleKey)

    if (availability.state === 'disabled') {
      const reason = t(availability.reasonKey)
      const remote = availability.reasonKey === 'shell:nav.notAvailableRemote'
      if (sidebarCollapsed) {
        return (
          <DisabledNavTooltip key={route.path} reason={reason}>
            <div
              className="flex min-h-9 cursor-not-allowed items-center justify-center rounded-md px-2 py-2 opacity-45"
              aria-disabled="true"
              aria-label={`${fullTitle} — ${reason}`}
            >
              <Icon className="h-[15px] w-[15px] shrink-0 text-muted-foreground/50" />
            </div>
          </DisabledNavTooltip>
        )
      }
      return (
        <DisabledNavTooltip key={route.path} reason={reason}>
          <div
            className={cn('flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px]', remote ? 'opacity-55' : 'cursor-not-allowed opacity-50')}
            aria-label={`${label} — ${reason}`}
            aria-disabled="true"
          >
            <Icon className="h-[15px] w-[15px] shrink-0 text-muted-foreground/50" />
            <span className={cn('truncate text-muted-foreground/70', remote && 'line-through decoration-muted-foreground/30')}>{label}</span>
            {remote && (
              <Badge variant="outline" className="ms-auto px-1 py-0 text-[10px] uppercase tracking-wider">
                {t('nav.localBadge')}
              </Badge>
            )}
          </div>
        </DisabledNavTooltip>
      )
    }

    const active = activeRoutePath === route.path
    if (sidebarCollapsed) {
      return (
        <Tooltip key={route.path}>
          <TooltipTrigger asChild>
            <Link
              to={route.path}
              aria-current={active ? 'page' : undefined}
              aria-label={fullTitle}
              onPointerEnter={preload(route)}
              onFocus={preload(route)}
              onClick={() => setMobileMenuOpen(false)}
              className={cn(
                'group relative flex min-h-9 items-center justify-center rounded-md border border-transparent px-2 py-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                active ? cn('font-medium', tone.rowActive) : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'
              )}
            >
              {active && <span className={cn('absolute start-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-s-full', tone.bar)} aria-hidden />}
              <Icon className={cn('h-[15px] w-[15px] shrink-0', active ? tone.iconActive : 'text-muted-foreground/80 group-hover:text-foreground')} />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">{fullTitle}</TooltipContent>
        </Tooltip>
      )
    }

    return (
      <Link
        key={route.path}
        to={route.path}
        aria-current={active ? 'page' : undefined}
        onPointerEnter={preload(route)}
        onFocus={preload(route)}
        onClick={() => setMobileMenuOpen(false)}
        className={cn(
          'group relative flex min-h-9 items-center gap-2.5 rounded-md border border-transparent px-2 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
          active ? cn('font-medium text-foreground', tone.rowActive) : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'
        )}
      >
        {active && <span className={cn('absolute start-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-s-full', tone.bar)} aria-hidden />}
        <Icon className={cn('h-[15px] w-[15px] shrink-0 transition-colors', active ? tone.iconActive : 'text-muted-foreground/80 group-hover:text-foreground')} />
        <span className="truncate">{label}</span>
        {rowBadge(route, active)}
      </Link>
    )
  }

  const sectionHasSignal = (section: NavSection) =>
    (section.id === 'server' && modUpdatesAvailable > 0) ||
    (section.id === 'players' && shownPlayerCount > 0) ||
    (section.id === 'panel' && !!panelUpdateAvailable)

  // "Search… Ctrl K": the palette's visible way in. In the rail, an icon.
  const searchButton = sidebarCollapsed ? (
    <div className="flex justify-center border-b border-border/40 p-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={openPalette}
            aria-label={t('search.label')}
            aria-keyshortcuts="Control+K Meta+K"
            className={FOOTER_ICON_BUTTON}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {t('search.label')} <kbd className="ms-1 font-sans text-micro text-muted-foreground">{modKey} K</kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  ) : (
    <div className="border-b border-border/40 px-2 py-2">
      <button
        type="button"
        onClick={openPalette}
        aria-label={t('search.label')}
        aria-keyshortcuts="Control+K Meta+K"
        className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background/40 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="flex-1 truncate text-start">{t('search.placeholder')}</span>
        <kbd className="shrink-0 rounded border border-border/60 px-1 text-micro text-muted-foreground [@media(pointer:coarse)]:hidden" aria-hidden>{modKey} K</kbd>
      </button>
    </div>
  )

  const activeServerStrip = servers && servers.length > 0 && !sidebarCollapsed && (
    <DropdownMenu onOpenChange={(open) => { if (open) void loadSwitcherStates() }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "active-server-strip group relative w-full border-b border-border/40 px-3 py-2.5 text-start transition-colors",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60",
            `active-server-strip--${serverRunState}`
          )}
        >
          {/* Start-edge accent — pulses on running, dim on stopped */}
          <span className="active-server-strip__edge" aria-hidden />

          <div className="flex items-center gap-1.5">
            <span className="label-micro">{t('activeServer.label')}</span>
            <span className="ms-1 inline-block h-px flex-1 bg-gradient-to-r rtl:bg-gradient-to-l from-border/40 to-transparent" aria-hidden />
            <ChevronDown className="h-3 w-3 text-muted-foreground/60 transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="active-server-strip__dot relative h-2.5 w-2.5 shrink-0 rounded-full" aria-hidden>
              <span className="absolute inset-0 rounded-full" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold leading-tight text-foreground transition-colors group-hover:text-primary">
              {activeServer?.name || t('activeServer.none')}
            </span>
            {serverRunState === 'running' && playerCount > 0 && (
              <Badge
                variant="success"
                className="shrink-0 px-1.5 py-0 text-[10px] leading-none"
                title={t('activeServer.playersOnline', { count: playerCount })}
              >
                {playerCountLabel}
              </Badge>
            )}
            {activeServer?.isRemote && (
              <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground/80" title={t('activeServer.remoteTitle')}>
                {t('activeServer.remoteBadge')}
              </Badge>
            )}
            <span className="sr-only">{serverStateLabel}</span>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60 glass border-border/50">
        {switchDeniedReason && servers.length > 1 && (
          <p className="px-3 pb-1.5 pt-2 text-xs text-muted-foreground">{switchDeniedReason}</p>
        )}
        {servers.map(server => (
          <DropdownMenuItem
            key={server.id}
            onClick={() => handleSwitchServer(server)}
            disabled={!server.isActive && !canSwitchServer}
            className={cn(
              "py-2.5 px-3 cursor-pointer transition-colors",
              server.isActive && 'bg-primary/10'
            )}
          >
            <div className="flex items-center gap-3 w-full">
              <div className={cn(
                "relative w-8 h-8 rounded-lg flex items-center justify-center",
                server.isActive ? "bg-primary/20" : "bg-muted/70"
              )}>
                <Server className={cn("w-4 h-4", server.isActive && "text-primary")} />
                {/* With several servers: which ones are up, without switching
                    to each. Local servers only -- the process scan can't
                    see a remote one. */}
                {!server.isRemote && switcherStates[String(server.id)] !== undefined && (
                  <>
                    <span
                      className={cn(
                        "absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-popover",
                        switcherStates[String(server.id)] ? "bg-success" : "bg-muted-foreground/50",
                      )}
                      aria-hidden
                    />
                    <span className="sr-only">
                      {switcherStates[String(server.id)] ? t('activeServer.statusRunning') : t('activeServer.statusStopped')}
                    </span>
                  </>
                )}
              </div>
              <span className="truncate flex-1 font-medium">{server.name}</span>
              {server.isRemote && (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground/80" title={t('activeServer.remoteTitle')}>
                  {t('activeServer.remoteBadgeFull')}
                </Badge>
              )}
              {server.isActive && (
                <Badge variant="secondary" className="px-2 py-0.5 text-xs">
                  {t('activeServer.activeBadge')}
                </Badge>
              )}
            </div>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void guardedNavigate('/server-setup')} className="py-2.5 px-3">
          <Plus className="w-4 h-4 me-2" />
          {t('activeServer.addServer')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void guardedNavigate('/servers')} className="py-2.5 px-3">
          <Layers className="w-4 h-4 me-2" />
          {t('activeServer.manageServers')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const mainWidth =
    currentRoute?.layout === 'wide' ? 'max-w-none' : currentRoute?.layout === 'narrow' ? 'max-w-3xl' : 'max-w-7xl'

  return (
    <div className="flex h-screen bg-background">
      {/* Focus moves in script: under the demo's HashRouter a plain
          #main-content jump was read as a route, the 404 page. */}
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById('main-content')?.focus()
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:start-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:text-sm"
      >
        {t('skipToContent')}
      </a>
      {/* Mobile top bar: the menu, where you are, and which server. */}
      <div className="fixed top-0 inset-x-0 z-50 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85 lg:hidden">
        <div className="flex h-16 items-center gap-2 px-2">
          <Button
            ref={mobileMenuButtonRef}
            variant="ghost"
            size="icon"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? t('mobileMenu.close') : t('mobileMenu.open')}
            aria-expanded={mobileMenuOpen}
            className="h-11 w-11 shrink-0 rounded-lg border border-transparent hover:border-border/70 focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2"
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </Button>
          {/* Rendered below lg only, so the desktop DOM carries the server
              name and state once (in the sidebar strip). */}
          {!isLg && (
            <p className="min-w-0 flex-1 truncate text-base font-semibold text-foreground" data-testid="mobile-page-title">
              {currentTitle ?? t('brand.documentTitle')}
            </p>
          )}
          {!isLg && activeServer && (
            <span className="flex min-w-0 max-w-[45%] shrink items-center gap-1.5 pe-2 text-xs text-muted-foreground">
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  serverRunState === 'running' && 'bg-success',
                  serverRunState === 'stopped' && 'bg-destructive',
                  (serverRunState === 'transitioning' || serverRunState === 'unresponsive') && 'bg-warning motion-safe:animate-pulse',
                  serverRunState === 'unknown' && 'bg-muted-foreground/50',
                )}
                aria-hidden
              />
              <span className="truncate">{activeServer.name}</span>
              <span className="sr-only">{serverStateLabel}</span>
            </span>
          )}
        </div>
      </div>

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/50 backdrop-blur-[1px] lg:hidden"
          onClick={() => { setMobileMenuOpen(false); mobileMenuButtonRef.current?.focus() }}
          aria-hidden="true"
        />
      )}

      {/* Sidebar - Desktop always visible, Mobile as slide-out */}
      <aside
        ref={mobileMenuAsideRef}
        aria-label={t('nav.sidebarAriaLabel')}
        className={cn(
        // start-0 and the rtl: translate: in Arabic the drawer slides in
        // from the right, beside the menu button, where the sidebar sits.
        "fixed inset-y-0 start-0 z-40 flex flex-col border-e bg-card transform transition-all duration-300 ease-out will-change-[width,transform] motion-reduce:transition-none lg:relative",
        sidebarCollapsed ? "lg:w-[60px]" : "lg:w-64",
        "w-72",
        "lg:translate-x-0 lg:rtl:translate-x-0",
        mobileMenuOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full",
        "pt-16 lg:pt-0" // Add padding for mobile header
      )}>
      <TooltipProvider delayDuration={150}>
        {/* Brand strip — desktop only: the drawer starts with Search instead
            of repeating the brand under the top bar. */}
        <div className={cn("brand-strip relative hidden overflow-hidden sidebar-header border-b border-border/50 lg:block")}>
          {/* Top broadcast accent — thin ember rule */}
          <div className="brand-strip__rule" aria-hidden />
          {/* Corner stencil */}
          <div className="brand-strip__corner" aria-hidden />

          <div className={cn("relative flex items-center", sidebarCollapsed ? "justify-center p-2" : "gap-2.5 px-3 py-2.5")}>
            <div className={cn("brand-icon-frame shrink-0", sidebarCollapsed && "brand-icon-frame--sm")}
                 aria-hidden>
              <img
                src={`${import.meta.env.BASE_URL}spiffo.png`}
                alt="Spiffo"
                loading="lazy"
                width={sidebarCollapsed ? 24 : 30}
                height={sidebarCollapsed ? 24 : 30}
                className={cn(sidebarCollapsed ? "h-6 w-6" : "h-[30px] w-[30px]", "object-contain drop-shadow-sm")}
              />
            </div>
            {!sidebarCollapsed && (
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <div className="flex items-center gap-2">
                  <span className="shell-brand-title truncate text-[15px] uppercase leading-none tracking-[0.18em]">
                    {t('brand.shortTitle')}
                  </span>
                  <span className="brand-led" aria-hidden title={t('panelStatus.online')} />
                </div>
                <div className="flex items-center gap-1.5 text-micro font-medium uppercase leading-none tracking-[0.2em] text-muted-foreground/80">
                  <span className="shell-brand-subtitle truncate uppercase">{t('brand.shortSubtitle')}</span>
                  <span className="brand-strip__version font-mono normal-case tracking-normal text-muted-foreground/55">
                    v{panelVersion || (typeof __PANEL_VERSION__ !== 'undefined' ? __PANEL_VERSION__ : '0')}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* In the drawer, Search comes first, then the server switcher. */}
        {!isLg && searchButton}

        {/* No-server notice — the active-server strip below only renders once
            a server exists, so without this a brand-new install shows nothing
            between the header and a sidebar full of inert-looking nav items.
            Visible without hovering, unlike the per-item tooltip/aria-label
            (which stay in place for screen readers — this is additive, not a
            replacement). Reuses SystemHealthBanner's warning-strip language
            (border-warning/35, AlertCircle) rather than a new color. */}
        {serversConfirmedEmpty && !sidebarCollapsed && (
          <div className="border-b border-border/40 bg-warning/5 px-3 py-2.5 shadow-[inset_2px_0_0_hsl(var(--warning))]">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-warning mt-0.5" aria-hidden />
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold leading-tight text-foreground">
                  {t('nav.noServerBanner.title')}
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {t('nav.noServerBanner.description')}
                </p>
                <NavLink
                  to="/server-setup"
                  onClick={() => setMobileMenuOpen(false)}
                  className="mt-1.5 inline-flex items-center text-[11px] font-medium text-primary hover:underline"
                >
                  {t('nav.noServerBanner.cta')}
                </NavLink>
              </div>
            </div>
          </div>
        )}

        {/* Active server strip — tactical status bar */}
        {activeServerStrip}

        {isLg && searchButton}

        {/* Navigation — from the route registry */}
        <nav ref={navRef} aria-label={t('nav.ariaLabel')} className="flex-1 overflow-y-auto nav-scroll px-2 py-2">
          {/* Dashboard — always pinned at top */}
          {renderRow(DASHBOARD_ROUTE, 'primary')}

          {NAV_SECTIONS.map((section) => {
            const tone = ACCENT_STYLES[section.accent]
            const rows = section.paths.map((path) => renderRow(getRouteMeta(path) as RouteMeta, section.accent)).filter(Boolean)
            if (rows.length === 0) return null

            // Collapsed (icon rail) mode — separators between sections
            if (sidebarCollapsed) {
              return (
                <div key={section.id} className="mt-2 space-y-0.5 border-t border-border/40 pt-2">
                  {rows}
                </div>
              )
            }

            return (
              <div key={section.id} className="mt-3">
                {/* Lane label */}
                <div className="mb-1 flex items-center gap-2 px-2">
                  <span className={cn('h-px w-3 rounded-full', tone.bar)} aria-hidden="true" />
                  <span className={cn('label-micro leading-none', tone.label)}>
                    {t(section.labelKey)}
                  </span>
                  {sectionHasSignal(section) && (
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        section.id === 'players' ? 'bg-success' : 'bg-warning motion-safe:animate-pulse'
                      )}
                      aria-hidden
                    />
                  )}
                  <span className="h-px flex-1 bg-border/30" aria-hidden />
                </div>
                <div className="space-y-0.5">{rows}</div>
              </div>
            )
          })}
        </nav>

        {/* Footer: the connection notice (only while live updates are down),
            the Ko-fi button, then the two quiet utility rows together: who is
            signed in, and the toolbar (version on the left; language, GitHub,
            shortcuts and the collapse toggle on the right). */}
        <div className={cn('border-t border-border/30', sidebarCollapsed ? 'p-2' : 'px-3 pt-2.5 pb-2')}>
          <ConnectionAnnouncer />
          {!sidebarCollapsed ? (
            <div className="space-y-2.5">
              <ConnectionStatus showLabel className="w-full px-2 py-1" />
              {/* Ko-fi's own "Support me on Ko-fi" button, drawn here rather
                  than with its widget script (see KofiCup). Dark text: white
                  on Ko-fi's blue is only about 2.5:1. No aria-label, so the
                  accessible name is the visible text; 36px on touch, like
                  the nav rows. */}
              <a
                href={KOFI_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-[#72a4f2] px-2 text-xs font-semibold text-[#0f2340] shadow-sm transition-[filter] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card [@media(pointer:coarse)]:h-9"
              >
                <KofiCup className="h-4 w-4 shrink-0" />
                {t('footer.supportMeKofi')}
                <span className="sr-only"> {t('footer.opensInNewTab')}</span>
              </a>
              <div className="space-y-2">
                <AuthFooter onSignOut={() => void handleSignOut()} />
                <div className="flex items-center gap-1.5">
                  {/* With an update waiting, the version itself becomes the
                      amber link to Settings > Updates: a separate badge does
                      not fit beside four icons in 231px. */}
                  {panelUpdateAvailable ? (
                    <NavLink
                      to="/settings?tab=updates"
                      onClick={() => setMobileMenuOpen(false)}
                      className="inline-flex h-5 min-w-0 items-center gap-1 rounded-full border border-warning/70 bg-warning px-1.5 font-mono text-[10px] font-medium text-warning-foreground transition-colors hover:bg-warning/90 focus-visible:outline-none focus-visible:rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card [@media(pointer:coarse)]:h-7"
                      title={panelUpdateAvailable.version
                        ? t('panelUpdateBadge.titleWithVersionOpenSettings', { version: panelUpdateAvailable.version })
                        : t('panelUpdateBadge.titleNoVersionOpenSettings')}
                    >
                      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning-foreground/70 motion-safe:animate-pulse" />
                      <span className="truncate">v{displayVersion}</span>
                      <span className="sr-only"> {t('panelUpdateBadge.update')}</span>
                    </NavLink>
                  ) : (
                    <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                      v{displayVersion}
                    </span>
                  )}
                  <span className="ms-auto flex shrink-0 items-center">
                    <LanguageSwitcher compact className={FOOTER_ICON_BUTTON} />
                    <a
                      href="https://github.com/fpsacha/zomboid-control-panel"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={FOOTER_ICON_BUTTON}
                      aria-label={t('footer.githubRepo')}
                      title={t('footer.githubRepo')}
                    >
                      <Github className="h-3.5 w-3.5" />
                    </a>
                    <button
                      type="button"
                      onClick={() => setHelpOpen(true)}
                      className={FOOTER_ICON_BUTTON}
                      aria-label={t('footer.keyboardShortcuts')}
                      title={t('footer.keyboardShortcutsTitle')}
                    >
                      <kbd className="inline-flex h-4 w-4 items-center justify-center rounded border border-border/50 text-[10px] font-mono leading-none">?</kbd>
                    </button>
                    <button
                      type="button"
                      onClick={toggleSidebar}
                      className={cn(FOOTER_ICON_BUTTON, 'hidden lg:grid')}
                      aria-label={t('footer.collapseSidebar')}
                      title={t('footer.collapseSidebar')}
                    >
                      <PanelLeftClose className="h-3.5 w-3.5 rtl:-scale-x-100" />
                    </button>
                  </span>
                </div>
              </div>
            </div>
          ) : (
            // The rail only exists at lg (see sidebarCollapsed): one column of
            // 28px squares, each with a tooltip to the right.
            <div className="flex flex-col items-center gap-1.5">
              <ConnectionStatus className="h-7 w-7 justify-center p-0" />
              {/* The account row (name and Sign out) only exists in the
                  expanded footer, and the rail is remembered: without this a
                  collapsed sidebar left no way to sign out. */}
              {authEnabled && user && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => void handleSignOut()}
                      className={FOOTER_ICON_BUTTON}
                      aria-label={t('footer.signOut')}
                    >
                      <LogOut className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {t('footer.signOut')}
                    <bdi className="block text-muted-foreground">{user.username}</bdi>
                  </TooltipContent>
                </Tooltip>
              )}
              <LanguageSwitcher compact className={FOOTER_ICON_BUTTON} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={KOFI_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="grid h-7 w-7 place-items-center rounded-md bg-[#72a4f2] shadow-sm transition-[filter] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                    aria-label={`${t('footer.supportMeKofi')} ${t('footer.opensInNewTab')}`}
                  >
                    <KofiCup className="h-4 w-4" />
                  </a>
                </TooltipTrigger>
                <TooltipContent side="right">{t('footer.supportMeKofi')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={toggleSidebar}
                    className={FOOTER_ICON_BUTTON}
                    aria-label={t('footer.expandSidebar')}
                  >
                    <PanelLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{t('footer.expandSidebar')}</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </TooltipProvider>
      </aside>

      {/* Main Content */}
      <main id="main-content" tabIndex={-1} className="flex-1 overflow-auto pt-16 focus:outline-none lg:pt-0">
        <div className={cn('mx-auto p-4 lg:p-8', mainWidth)}>
          <SystemHealthBanner />
          {/* Server Update Banner: a warning strip with the build delta (data, in mono). */}
          {updateInfo && updateInfo.updateAvailable && !updateDismissed && (
            <div
              role="status"
              className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-warning/35 bg-warning/5 py-2 ps-3 pe-2 shadow-[inset_2px_0_0_hsl(var(--warning))]"
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-warning" />
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="label-micro text-warning">
                  {t('updateBanner.label')}
                </span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  <Trans
                    t={t}
                    i18nKey="updateBanner.newBuildOn"
                    values={{ branch: updateInfo.installed.branch }}
                    components={{ b: <span className="font-medium text-foreground" /> }}
                  />
                  {updateInfo.latest.description && (
                    <span className="text-muted-foreground/70"> · {updateInfo.latest.description}</span>
                  )}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-foreground/85">
                  b{updateInfo.installed.buildId} <span className="text-muted-foreground/60">→</span> b{updateInfo.latest.buildId}
                </span>
              </div>
              <div className="ms-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setUpdateDismissed(true)
                    const key = updateInfo && updateInfo.installed && updateInfo.latest
                      ? `updateBannerDismissed:${updateInfo.installed.buildId}->${updateInfo.latest.buildId}`
                      : null
                    if (key) writeStored(key, 'true')
                  }}
                >
                  {t('updateBanner.dismiss')}
                </Button>
                <Button
                  size="sm"
                  variant="warning"
                  className="h-7 gap-1.5 px-2.5 text-xs font-semibold"
                  onClick={() => void guardedNavigate('/servers')}
                >
                  <RefreshCw className="h-3 w-3" />
                  {t('updateBanner.updateServer')}
                </Button>
              </div>
            </div>
          )}
          {children}
        </div>
      </main>
      <KeyboardShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} shortcuts={shortcuts} />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        servers={servers}
        activeServer={activeServer}
        onSwitchServer={handleSwitchServer}
        onShowShortcuts={showShortcuts}
      />
    </div>
  )
}
