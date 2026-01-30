import { Routes, Route } from 'react-router-dom'
import { useEffect, useState, useCallback, lazy, Suspense } from 'react'
import { io, Socket } from 'socket.io-client'
import Layout from './components/Layout'
import { ErrorBoundary } from './components/ErrorBoundary'
import {
  DashboardErrorBoundary,
  PlayersErrorBoundary,
  ConsoleErrorBoundary,
  SchedulerErrorBoundary,
  ModsErrorBoundary,
  ChunkCleanerErrorBoundary,
  DiscordErrorBoundary,
  SettingsErrorBoundary,
  ServerSetupErrorBoundary,
  ServersErrorBoundary,
  ServerConfigErrorBoundary,
  EventsErrorBoundary,
  ChatErrorBoundary,
  BackupsErrorBoundary,
  FeatureErrorBoundary,
} from './components/FeatureErrorBoundary'
import Dashboard from './pages/Dashboard'
import { Toaster } from './components/ui/toaster'
import { SocketContext, ConnectionStatus, ConnectionStatusContext } from './contexts/SocketContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { TooltipProvider } from './components/ui/tooltip'
import { useToast } from './components/ui/use-toast'
import { Loader2 } from 'lucide-react'

// Lazy load larger pages for code splitting
const Players = lazy(() => import('./pages/Players'))
const Console = lazy(() => import('./pages/Console'))
const Scheduler = lazy(() => import('./pages/Scheduler'))
const Mods = lazy(() => import('./pages/Mods'))
const ChunkCleaner = lazy(() => import('./pages/ChunkCleaner'))
const Discord = lazy(() => import('./pages/Discord'))
const Settings = lazy(() => import('./pages/Settings'))
const ServerSetup = lazy(() => import('./pages/ServerSetup'))
const Servers = lazy(() => import('./pages/Servers'))
const ServerConfig = lazy(() => import('./pages/ServerConfig'))
const Debug = lazy(() => import('./pages/Debug'))
const ServerFinder = lazy(() => import('./pages/ServerFinder'))
const Events = lazy(() => import('./pages/Events'))
const Chat = lazy(() => import('./pages/Chat'))
const Backups = lazy(() => import('./pages/Backups'))

// Loading fallback component
function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  )
}

function AppContent() {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
    reconnecting: false,
    reconnectAttempt: 0,
    error: null,
  })
  const { toast } = useToast()

  const handleReconnectSuccess = useCallback(() => {
    toast({
      title: 'Reconnected',
      description: 'Connection to server restored',
      variant: 'success' as const,
    })
  }, [toast])

  useEffect(() => {
    const newSocket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    })

    // Connection established
    newSocket.on('connect', () => {
      setConnectionStatus(prev => {
        // Show toast only on reconnect, not initial connect
        if (prev.reconnecting || prev.reconnectAttempt > 0) {
          handleReconnectSuccess()
        }
        return {
          connected: true,
          reconnecting: false,
          reconnectAttempt: 0,
          error: null,
        }
      })
      // Subscribe to updates
      newSocket.emit('subscribe:status')
      newSocket.emit('subscribe:players')
      newSocket.emit('subscribe:logs')
    })

    // Connection lost
    newSocket.on('disconnect', (reason) => {
      setConnectionStatus(prev => ({
        ...prev,
        connected: false,
        error: reason === 'io server disconnect' ? 'Server closed connection' : null,
      }))
    })

    // Connection error with detailed logging (from Socket.IO best practices)
    newSocket.on('connect_error', (err) => {
      console.error('Connection error:', err.message)
      if (newSocket.active) {
        // Temporary failure, socket will automatically reconnect
        setConnectionStatus(prev => ({
          ...prev,
          connected: false,
          reconnecting: true,
          error: err.message,
        }))
      } else {
        // Connection denied by server - needs manual reconnect
        setConnectionStatus({
          connected: false,
          reconnecting: false,
          reconnectAttempt: 0,
          error: err.message,
        })
      }
    })

    // Reconnection events
    newSocket.io.on('reconnect_attempt', (attempt) => {
      setConnectionStatus(prev => ({
        ...prev,
        reconnecting: true,
        reconnectAttempt: attempt,
      }))
    })

    newSocket.io.on('reconnect_failed', () => {
      console.error('All reconnection attempts failed')
      setConnectionStatus({
        connected: false,
        reconnecting: false,
        reconnectAttempt: 0,
        error: 'Failed to reconnect after multiple attempts',
      })
      toast({
        title: 'Connection Lost',
        description: 'Unable to reconnect to server. Please refresh the page.',
        variant: 'destructive',
      })
    })

    setSocket(newSocket)

    return () => {
      newSocket.close()
    }
  }, [toast, handleReconnectSuccess])

  return (
    <ConnectionStatusContext.Provider value={connectionStatus}>
      <SocketContext.Provider value={socket}>
        <Layout>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<DashboardErrorBoundary><Dashboard /></DashboardErrorBoundary>} />
              <Route path="/players" element={<PlayersErrorBoundary><Players /></PlayersErrorBoundary>} />
              <Route path="/console" element={<ConsoleErrorBoundary><Console /></ConsoleErrorBoundary>} />
              <Route path="/scheduler" element={<SchedulerErrorBoundary><Scheduler /></SchedulerErrorBoundary>} />
              <Route path="/mods" element={<ModsErrorBoundary><Mods /></ModsErrorBoundary>} />
              <Route path="/chunks" element={<ChunkCleanerErrorBoundary><ChunkCleaner /></ChunkCleanerErrorBoundary>} />
              <Route path="/discord" element={<DiscordErrorBoundary><Discord /></DiscordErrorBoundary>} />
              <Route path="/settings" element={<SettingsErrorBoundary><Settings /></SettingsErrorBoundary>} />
              <Route path="/server-setup" element={<ServerSetupErrorBoundary><ServerSetup /></ServerSetupErrorBoundary>} />
              <Route path="/servers" element={<ServersErrorBoundary><Servers /></ServersErrorBoundary>} />
              <Route path="/server-config" element={<ServerConfigErrorBoundary><ServerConfig /></ServerConfigErrorBoundary>} />
              <Route path="/server-finder" element={<FeatureErrorBoundary featureName="Server Finder"><ServerFinder /></FeatureErrorBoundary>} />
              <Route path="/debug" element={<FeatureErrorBoundary featureName="Debug"><Debug /></FeatureErrorBoundary>} />
              <Route path="/events" element={<EventsErrorBoundary><Events /></EventsErrorBoundary>} />
              <Route path="/chat" element={<ChatErrorBoundary><Chat /></ChatErrorBoundary>} />
              <Route path="/backups" element={<BackupsErrorBoundary><Backups /></BackupsErrorBoundary>} />
            </Routes>
          </Suspense>
        </Layout>
        <Toaster />
      </SocketContext.Provider>
    </ConnectionStatusContext.Provider>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <TooltipProvider>
          <AppContent />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
