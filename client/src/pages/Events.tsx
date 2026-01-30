import { useState, useCallback, useEffect } from 'react'
import { 
  Zap,
  Crosshair,
  Volume2,
  CloudLightning,
  Cloud,
  CloudRain,
  CloudOff,
  Skull,
  Bell,
  Users,
  User,
  Loader2,
  RefreshCw,
  Target,
  MapPin,
  Clock,
  Navigation,
  Car,
  Megaphone,
  Snowflake,
  Wind,
  Thermometer,
  AlertTriangle,
  Settings,
  Droplets,
  Sun,
  Moon,
  Eye,
  Gauge,
  RotateCcw,
  Calendar
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { rconApi, playersApi, panelBridgeApi } from '@/lib/api'
import { Link } from 'react-router-dom'

interface Player {
  name: string
  online: boolean
}

export default function Events() {
  const [loading, setLoading] = useState<string | null>(null)
  const [players, setPlayers] = useState<Player[]>([])
  const [selectedPlayer, setSelectedPlayer] = useState<string>('')
  const [targetAll, setTargetAll] = useState(true)
  
  // Weather controls
  const [rainIntensity, setRainIntensity] = useState(50)
  const [stormDuration, setStormDuration] = useState(1)
  
  // Horde controls
  const [hordeCount, setHordeCount] = useState(50)
  
  // Time controls
  const [timeSpeed, setTimeSpeed] = useState(1)
  
  // Teleport coordinates
  const [teleportX, setTeleportX] = useState('')
  const [teleportY, setTeleportY] = useState('')
  const [teleportZ, setTeleportZ] = useState('0')
  
  // Vehicle spawning
  const [selectedVehicle, setSelectedVehicle] = useState('Base.VanAmbulance')
  
  // Announcements
  const [announcement, setAnnouncement] = useState('')
  
  // Panel Bridge state
  const [bridgeConnected, setBridgeConnected] = useState(false)
  const [bridgeLoading, setBridgeLoading] = useState<string | null>(null)
  const [blizzardDuration, setBlizzardDuration] = useState(2)
  const [tropicalDuration, setTropicalDuration] = useState(2)
  
  // Climate controls (v1.1.0)
  const [fogIntensity, setFogIntensity] = useState(0)
  const [windIntensity, setWindIntensity] = useState(0)
  const [temperature, setTemperature] = useState(20)
  const [cloudIntensity, setCloudIntensity] = useState(0)
  const [humidity, setHumidity] = useState(50)
  const [precipitationIntensity, setPrecipitationIntensity] = useState(0)
  
  // Time controls (v1.1.0)
  const [gameHour, setGameHour] = useState(12)
  const [gameDay, setGameDay] = useState(1)
  const [gameMonth, setGameMonth] = useState(7)
  
  // Sound controls (v1.2.0)
  const [soundRadius, setSoundRadius] = useState(100)
  const [soundVolume, setSoundVolume] = useState(100)
  const [soundX, setSoundX] = useState('')
  
  // Utilities status (v1.4.0)
  const [utilitiesStatus, setUtilitiesStatus] = useState<{
    hydroPowerOn: boolean
    powerOn: boolean
    waterOn: boolean
    elecShut: string
    waterShut: string
  } | null>(null)
  const [soundY, setSoundY] = useState('')
  
  const { toast } = useToast()

  // Vehicle presets for GM
  const vehicles = [
    { id: 'Base.VanAmbulance', name: 'Ambulance', icon: '🚑' },
    { id: 'Base.PickUpVanLightsPolice', name: 'Police Van', icon: '🚔' },
    { id: 'Base.CarLightsPolice', name: 'Police Car', icon: '🚓' },
    { id: 'Base.PickUpTruckMccoy', name: 'Pickup Truck', icon: '🛻' },
    { id: 'Base.Van', name: 'Van', icon: '🚐' },
    { id: 'Base.ModernCar', name: 'Modern Car', icon: '🚗' },
    { id: 'Base.SportsCar', name: 'Sports Car', icon: '🏎️' },
    { id: 'Base.SUV', name: 'SUV', icon: '🚙' },
    { id: 'Base.StepVan', name: 'Step Van', icon: '📦' },
    { id: 'Base.Taxi', name: 'Taxi', icon: '🚕' },
  ]



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
      const status = await panelBridgeApi.getStatus()
      setBridgeConnected(status.modConnected)
      
      // If connected, fetch climate floats
      if (status.modConnected) {
        try {
          const floatsResult = await panelBridgeApi.getClimateFloats()
          if (floatsResult.success && floatsResult.data?.floats) {
            // Update individual state from current values
            const floats = floatsResult.data.floats
            const findFloat = (id: number) => floats.find((f: { id: number; value: number }) => f.id === id)?.value
            setFogIntensity(Math.round((findFloat(5) ?? 0) * 100))
            setWindIntensity(Math.round((findFloat(6) ?? 0) * 100))
            setTemperature(Math.round(findFloat(4) ?? 20))
            setCloudIntensity(Math.round((findFloat(8) ?? 0) * 100))
            setHumidity(Math.round((findFloat(12) ?? 0.5) * 100))
            setPrecipitationIntensity(Math.round((findFloat(3) ?? 0) * 100))
          }
        } catch {
          // Ignore climate fetch errors
        }
        
        // Also fetch current game time
        try {
          const timeResult = await panelBridgeApi.getGameTime()
          if (timeResult.success && timeResult.data) {
            setGameHour(Math.floor(timeResult.data.hour))
            setGameDay(timeResult.data.day)
            setGameMonth(timeResult.data.month)
          }
        } catch {
          // Ignore time fetch errors
        }
        
        // Fetch utilities status
        try {
          const utilitiesResult = await panelBridgeApi.getUtilitiesStatus()
          if (utilitiesResult.success && utilitiesResult.data) {
            setUtilitiesStatus(utilitiesResult.data)
          }
        } catch {
          // Ignore utilities fetch errors
        }
      }
    } catch (error) {
      setBridgeConnected(false)
    }
  }, [])

  useEffect(() => {
    fetchPlayers()
    checkBridgeStatus()
    const interval = setInterval(fetchPlayers, 30000)
    const bridgeInterval = setInterval(checkBridgeStatus, 10000)
    return () => {
      clearInterval(interval)
      clearInterval(bridgeInterval)
    }
  }, [fetchPlayers, checkBridgeStatus])

  // Bridge weather commands
  const handleBridgeAction = async (action: string, fn: () => Promise<unknown>) => {
    setBridgeLoading(action)
    try {
      await fn()
      toast({
        title: 'Success',
        description: `${action} triggered successfully`,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Action failed',
        variant: 'destructive',
      })
    } finally {
      setBridgeLoading(null)
    }
  }

  // Utilities action handler with status refresh
  const handleUtilitiesAction = async (action: string, fn: () => Promise<unknown>) => {
    await handleBridgeAction(action, async () => {
      await fn()
      // Refresh utilities status after action
      try {
        const result = await panelBridgeApi.getUtilitiesStatus()
        if (result.success && result.data) {
          setUtilitiesStatus(result.data)
        }
      } catch {
        // Ignore refresh errors
      }
    })
  }

  const executeCommand = async (command: string) => {
    const result = await rconApi.execute(command)
    if (!result.success) {
      throw new Error(result.error || 'Command failed')
    }
    return result
  }

  const handleAction = async (action: string, fn: () => Promise<unknown>) => {
    setLoading(action)
    try {
      await fn()
      toast({
        title: 'Success',
        description: `${action} triggered successfully`,
        variant: 'success' as const,
      })
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Action failed',
        variant: 'destructive',
      })
    } finally {
      setLoading(null)
    }
  }

  const getTargetPlayer = () => targetAll ? undefined : selectedPlayer || undefined

  // Weather commands
  const startRain = () => executeCommand(`startrain ${rainIntensity}`)
  const stopRain = () => executeCommand('stoprain')
  const startStorm = () => executeCommand(`startstorm ${stormDuration}`)
  const stopWeather = () => executeCommand('stopweather')
  
  // Sound/Event commands
  // Note: chopper and gunshot target a RANDOM online player, not the selected player
  const triggerChopper = () => executeCommand('chopper')
  const triggerGunshot = () => executeCommand('gunshot')
  const triggerLightning = (username?: string) => executeCommand(username ? `lightning "${username}"` : 'lightning')
  const triggerThunder = (username?: string) => executeCommand(username ? `thunder "${username}"` : 'thunder')
  // Alarm triggers at admin's in-game position (admin must be online)
  const triggerAlarm = () => executeCommand('alarm')
  
  // Zombie commands
  const createHorde = (count: number, username?: string) => 
    executeCommand(username ? `createhorde ${count} "${username}"` : `createhorde ${count}`)
  
  // createhorde2: spawns zombies behind the player (more cinematic)
  const createHorde2 = (count: number, username?: string) => 
    executeCommand(username ? `createhorde2 ${count} "${username}"` : `createhorde2 ${count}`)
  
  // removezombies: clears all zombies from the map
  const removeZombies = () => executeCommand('removezombies')
  
  // Time commands
  const setGameTimeSpeed = () => executeCommand(`setTimeSpeed ${timeSpeed}`)
  
  // Teleport commands
  // teleportto only works if admin is in-game and teleports themselves
  // For teleporting other players, use teleport command with player name and coordinates
  const teleportToCoords = (targetPlayer?: string) => {
    if (targetPlayer) {
      // Teleport specific player to coordinates
      return executeCommand(`teleport "${targetPlayer}" ${teleportX},${teleportY},${teleportZ}`)
    }
    // Self-teleport (requires admin to be in-game)
    return executeCommand(`teleportto ${teleportX},${teleportY},${teleportZ}`)
  }
  const teleportPlayerToPlayer = (player1: string, player2: string) =>
    executeCommand(`teleport "${player1}" "${player2}"`)
    
  // Vehicle commands
  const spawnVehicle = (vehicleId: string, username: string) =>
    executeCommand(`addvehicle "${vehicleId}" "${username}"`)
  
  // Announcement
  const sendAnnouncement = () => executeCommand(`servermsg "${announcement}"`)

  return (
    <div className="space-y-8 page-transition">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Events</h1>
          <p className="text-muted-foreground text-base sm:text-lg">Trigger in-game events and world effects</p>
        </div>
        <Button variant="outline" onClick={fetchPlayers} className="gap-2">
          <RefreshCw className="w-4 h-4" />
          Refresh Players
        </Button>
      </div>

      {/* Target Selection */}
      <Card className="card-interactive">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Target className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Event Target</CardTitle>
              <CardDescription className="mt-0.5">
                Choose whether events affect all players or a specific player
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                checked={targetAll}
                onCheckedChange={setTargetAll}
                id="target-all"
              />
              <Label htmlFor="target-all" className="flex items-center gap-2">
                <Users className="w-4 h-4" />
                Target All Players
              </Label>
            </div>
          </div>
          
          {!targetAll && (
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <User className="w-4 h-4" />
                Select Player
              </Label>
              <Select value={selectedPlayer} onValueChange={setSelectedPlayer}>
                <SelectTrigger className="w-full max-w-xs">
                  <SelectValue placeholder="Choose a player..." />
                </SelectTrigger>
                <SelectContent>
                  {players.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No players online</div>
                  ) : (
                    players.map((player) => (
                      <SelectItem key={player.name} value={player.name}>
                        {player.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {players.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No players are currently online. Some events require an online player to target.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Weather Controls */}
        <Card className="card-interactive">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
                <Cloud className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <CardTitle className="text-lg">Weather Controls</CardTitle>
                <CardDescription className="mt-0.5">Control the in-game weather</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Rain */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Rain Intensity: {rainIntensity}%</Label>
              </div>
              <Slider
                value={[rainIntensity]}
                onValueChange={([val]) => setRainIntensity(val)}
                min={1}
                max={100}
                step={1}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  onClick={() => handleAction('Start rain', startRain)}
                  disabled={loading !== null}
                  className="h-11 gap-2 hover:bg-blue-500/10 hover:text-blue-400 hover:border-blue-500/30"
                >
                  {loading === 'Start rain' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudRain className="w-4 h-4" />}
                  Start Rain
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleAction('Stop rain', stopRain)}
                  disabled={loading !== null}
                  className="h-11 gap-2"
                >
                  {loading === 'Stop rain' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudOff className="w-4 h-4" />}
                  Stop Rain
                </Button>
              </div>
            </div>

            {/* Storm */}
            <div className="space-y-3 pt-3 border-t">
              <div className="flex items-center justify-between">
                <Label>Storm Duration: {stormDuration} game hour{stormDuration !== 1 ? 's' : ''}</Label>
              </div>
              <Slider
                value={[stormDuration]}
                onValueChange={([val]) => setStormDuration(val)}
                min={1}
                max={24}
                step={1}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  onClick={() => handleAction('Start storm', startStorm)}
                  disabled={loading !== null}
                  className="h-11 gap-2 hover:bg-purple-500/10 hover:text-purple-400 hover:border-purple-500/30"
                >
                  {loading === 'Start storm' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudLightning className="w-4 h-4" />}
                  Start Storm
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleAction('Stop weather', stopWeather)}
                  disabled={loading !== null}
                  className="h-11 gap-2 hover:bg-emerald-500/10 hover:text-emerald-400 hover:border-emerald-500/30"
                >
                  {loading === 'Stop weather' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}
                  Clear Weather
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Advanced Weather Controls (via Panel Bridge) */}
        <Card className={`card-interactive ${!bridgeConnected ? 'opacity-60' : ''}`}>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center">
                <Snowflake className="w-5 h-5 text-cyan-400" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-lg">Advanced Weather</CardTitle>
                <CardDescription className="mt-0.5">
                  Blizzards, tropical storms, and snow control
                </CardDescription>
              </div>
              {bridgeConnected ? (
                <div className="flex items-center gap-1 text-emerald-500 text-sm">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  Connected
                </div>
              ) : (
                <Link to="/settings" className="text-sm text-amber-500 hover:underline flex items-center gap-1">
                  <Settings className="w-3 h-3" />
                  Setup Required
                </Link>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {!bridgeConnected ? (
              <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-amber-600 dark:text-amber-400">Panel Bridge Required</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      These advanced weather controls require the Panel Bridge mod to be installed and connected.
                      Go to <Link to="/settings" className="underline hover:text-foreground">Settings</Link> to set it up.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* Blizzard */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      <Snowflake className="w-4 h-4 text-cyan-400" />
                      Blizzard Duration: {blizzardDuration} hour{blizzardDuration !== 1 ? 's' : ''}
                    </Label>
                  </div>
                  <Slider
                    value={[blizzardDuration]}
                    onValueChange={([val]) => setBlizzardDuration(val)}
                    min={1}
                    max={24}
                    step={1}
                  />
                  <Button
                    variant="outline"
                    onClick={() => handleBridgeAction('Blizzard', () => panelBridgeApi.triggerBlizzard(blizzardDuration))}
                    disabled={bridgeLoading !== null}
                    className="w-full h-11 gap-2 hover:bg-cyan-500/10 hover:text-cyan-400 hover:border-cyan-500/30"
                  >
                    {bridgeLoading === 'Blizzard' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Snowflake className="w-4 h-4" />}
                    Trigger Blizzard
                  </Button>
                </div>

                {/* Tropical Storm */}
                <div className="space-y-3 pt-3 border-t">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      <Wind className="w-4 h-4 text-teal-400" />
                      Tropical Storm Duration: {tropicalDuration} hour{tropicalDuration !== 1 ? 's' : ''}
                    </Label>
                  </div>
                  <Slider
                    value={[tropicalDuration]}
                    onValueChange={([val]) => setTropicalDuration(val)}
                    min={1}
                    max={24}
                    step={1}
                  />
                  <Button
                    variant="outline"
                    onClick={() => handleBridgeAction('Tropical Storm', () => panelBridgeApi.triggerTropicalStorm(tropicalDuration))}
                    disabled={bridgeLoading !== null}
                    className="w-full h-11 gap-2 hover:bg-teal-500/10 hover:text-teal-400 hover:border-teal-500/30"
                  >
                    {bridgeLoading === 'Tropical Storm' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wind className="w-4 h-4" />}
                    Trigger Tropical Storm
                  </Button>
                </div>

                {/* Quick Actions */}
                <div className="space-y-3 pt-3 border-t">
                  <Label className="flex items-center gap-2">
                    <Thermometer className="w-4 h-4" />
                    Quick Actions
                  </Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      onClick={() => handleBridgeAction('Enable Snow', () => panelBridgeApi.setSnow(true))}
                      disabled={bridgeLoading !== null}
                      className="h-11 gap-2 hover:bg-slate-500/10 hover:text-slate-400 hover:border-slate-500/30"
                    >
                      {bridgeLoading === 'Enable Snow' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Snowflake className="w-4 h-4" />}
                      Snow On
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleBridgeAction('Disable Snow', () => panelBridgeApi.setSnow(false))}
                      disabled={bridgeLoading !== null}
                      className="h-11 gap-2"
                    >
                      {bridgeLoading === 'Disable Snow' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudRain className="w-4 h-4" />}
                      Snow Off
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleBridgeAction('Stop All Weather', () => panelBridgeApi.stopWeather())}
                      disabled={bridgeLoading !== null}
                      className="h-11 gap-2 col-span-2 hover:bg-emerald-500/10 hover:text-emerald-400 hover:border-emerald-500/30"
                    >
                      {bridgeLoading === 'Stop All Weather' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}
                      Stop All Weather
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Climate Controls (v1.1.0) - spans full width */}
        <Card className={`card-interactive lg:col-span-2 ${!bridgeConnected ? 'opacity-60' : ''}`}>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/10 to-purple-500/10 flex items-center justify-center">
                <Gauge className="w-5 h-5 text-blue-400" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-lg">Climate Controls</CardTitle>
                <CardDescription className="mt-0.5">
                  Fine-tune weather parameters: fog, wind, temperature, clouds, and more
                </CardDescription>
              </div>
              {bridgeConnected && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleBridgeAction('Reset Climate', () => panelBridgeApi.resetClimateOverrides())}
                  disabled={bridgeLoading !== null}
                  className="gap-1"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!bridgeConnected ? (
              <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  Panel Bridge required for climate controls
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {/* Fog */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      <Eye className="w-4 h-4 text-gray-400" />
                      Fog: {fogIntensity}%
                    </Label>
                  </div>
                  <Slider
                    value={[fogIntensity]}
                    onValueChange={([val]) => setFogIntensity(val)}
                    min={0}
                    max={100}
                    step={5}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBridgeAction('Set Fog', () => panelBridgeApi.setClimateFloat(5, fogIntensity / 100))}
                    disabled={bridgeLoading !== null}
                    className="w-full"
                  >
                    Apply Fog
                  </Button>
                </div>

                {/* Wind */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      <Wind className="w-4 h-4 text-teal-400" />
                      Wind: {windIntensity}%
                    </Label>
                  </div>
                  <Slider
                    value={[windIntensity]}
                    onValueChange={([val]) => setWindIntensity(val)}
                    min={0}
                    max={100}
                    step={5}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBridgeAction('Set Wind', () => panelBridgeApi.setClimateFloat(6, windIntensity / 100))}
                    disabled={bridgeLoading !== null}
                    className="w-full"
                  >
                    Apply Wind
                  </Button>
                </div>

                {/* Temperature */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      <Thermometer className="w-4 h-4 text-orange-400" />
                      Temp: {temperature}°C
                    </Label>
                  </div>
                  <Slider
                    value={[temperature]}
                    onValueChange={([val]) => setTemperature(val)}
                    min={-30}
                    max={45}
                    step={1}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBridgeAction('Set Temperature', () => panelBridgeApi.setClimateFloat(4, temperature))}
                    disabled={bridgeLoading !== null}
                    className="w-full"
                  >
                    Apply Temp
                  </Button>
                </div>

                {/* Clouds */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      <Cloud className="w-4 h-4 text-slate-400" />
                      Clouds: {cloudIntensity}%
                    </Label>
                  </div>
                  <Slider
                    value={[cloudIntensity]}
                    onValueChange={([val]) => setCloudIntensity(val)}
                    min={0}
                    max={100}
                    step={5}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBridgeAction('Set Clouds', () => panelBridgeApi.setClimateFloat(8, cloudIntensity / 100))}
                    disabled={bridgeLoading !== null}
                    className="w-full"
                  >
                    Apply Clouds
                  </Button>
                </div>

                {/* Humidity */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      <Droplets className="w-4 h-4 text-blue-400" />
                      Humidity: {humidity}%
                    </Label>
                  </div>
                  <Slider
                    value={[humidity]}
                    onValueChange={([val]) => setHumidity(val)}
                    min={0}
                    max={100}
                    step={5}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBridgeAction('Set Humidity', () => panelBridgeApi.setClimateFloat(12, humidity / 100))}
                    disabled={bridgeLoading !== null}
                    className="w-full"
                  >
                    Apply Humidity
                  </Button>
                </div>

                {/* Precipitation */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      <CloudRain className="w-4 h-4 text-blue-500" />
                      Precipitation: {precipitationIntensity}%
                    </Label>
                  </div>
                  <Slider
                    value={[precipitationIntensity]}
                    onValueChange={([val]) => setPrecipitationIntensity(val)}
                    min={0}
                    max={100}
                    step={5}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBridgeAction('Set Precipitation', () => panelBridgeApi.setClimateFloat(3, precipitationIntensity / 100))}
                    disabled={bridgeLoading !== null}
                    className="w-full"
                  >
                    Apply Precipitation
                  </Button>
                </div>
              </div>
            )}
            
            {/* Rain & Lightning Quick Actions */}
            {bridgeConnected && (
              <div className="mt-6 pt-4 border-t">
                <Label className="flex items-center gap-2 mb-3">
                  <Zap className="w-4 h-4 text-yellow-400" />
                  Rain & Lightning
                </Label>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <Button
                    variant="outline"
                    onClick={() => handleBridgeAction('Start Rain', () => panelBridgeApi.startRain(1.0))}
                    disabled={bridgeLoading !== null}
                    className="gap-2 hover:bg-blue-500/10 hover:text-blue-400"
                  >
                    <CloudRain className="w-4 h-4" />
                    Start Rain
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleBridgeAction('Stop Rain', () => panelBridgeApi.stopRain())}
                    disabled={bridgeLoading !== null}
                    className="gap-2"
                  >
                    <CloudOff className="w-4 h-4" />
                    Stop Rain
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleAction('Lightning', () => triggerLightning())}
                    disabled={loading !== null}
                    className="gap-2 hover:bg-yellow-500/10 hover:text-yellow-400"
                  >
                    {loading === 'Lightning' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                    Lightning Strike
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleAction('Thunder', () => triggerThunder())}
                    disabled={loading !== null}
                    className="gap-2 hover:bg-purple-500/10 hover:text-purple-400"
                  >
                    {loading === 'Thunder' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudLightning className="w-4 h-4" />}
                    Thunder Only
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Game Time Control (v1.1.0) */}
        <Card className={`card-interactive ${!bridgeConnected ? 'opacity-60' : ''}`}>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <Calendar className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <CardTitle className="text-lg">Game Time</CardTitle>
                <CardDescription className="mt-0.5">Control in-game time and date</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {!bridgeConnected ? (
              <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  Panel Bridge required
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Hour */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      {gameHour >= 6 && gameHour < 20 ? (
                        <Sun className="w-4 h-4 text-yellow-400" />
                      ) : (
                        <Moon className="w-4 h-4 text-blue-300" />
                      )}
                      Hour: {gameHour}:00
                    </Label>
                  </div>
                  <Slider
                    value={[gameHour]}
                    onValueChange={([val]) => setGameHour(val)}
                    min={0}
                    max={23}
                    step={1}
                  />
                </div>

                {/* Quick time buttons */}
                <div className="flex gap-2 flex-wrap">
                  <Button variant="outline" size="sm" onClick={() => setGameHour(6)} className={gameHour === 6 ? 'border-amber-500/50' : ''}>
                    🌅 Dawn
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setGameHour(12)} className={gameHour === 12 ? 'border-amber-500/50' : ''}>
                    ☀️ Noon
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setGameHour(18)} className={gameHour === 18 ? 'border-amber-500/50' : ''}>
                    🌅 Dusk
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setGameHour(0)} className={gameHour === 0 ? 'border-amber-500/50' : ''}>
                    🌙 Midnight
                  </Button>
                </div>

                {/* Date controls */}
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Day</Label>
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={gameDay}
                      onChange={(e) => setGameDay(parseInt(e.target.value) || 1)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Month</Label>
                    <Select value={String(gameMonth)} onValueChange={(v) => setGameMonth(parseInt(v))}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">January</SelectItem>
                        <SelectItem value="2">February</SelectItem>
                        <SelectItem value="3">March</SelectItem>
                        <SelectItem value="4">April</SelectItem>
                        <SelectItem value="5">May</SelectItem>
                        <SelectItem value="6">June</SelectItem>
                        <SelectItem value="7">July</SelectItem>
                        <SelectItem value="8">August</SelectItem>
                        <SelectItem value="9">September</SelectItem>
                        <SelectItem value="10">October</SelectItem>
                        <SelectItem value="11">November</SelectItem>
                        <SelectItem value="12">December</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Button
                  variant="outline"
                  onClick={() => handleBridgeAction('Set Time', () => panelBridgeApi.setGameTime({ hour: gameHour, day: gameDay, month: gameMonth }))}
                  disabled={bridgeLoading !== null}
                  className="w-full h-11 gap-2 hover:bg-amber-500/10 hover:text-amber-400"
                >
                  {bridgeLoading === 'Set Time' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />}
                  Apply Time & Date
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Infrastructure (Power/Water) Control */}
        <Card className={`card-interactive ${!bridgeConnected ? 'opacity-60' : ''}`}>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-yellow-500/10 flex items-center justify-center">
                <Zap className="w-5 h-5 text-yellow-400" />
              </div>
              <div>
                <CardTitle className="text-lg">Infrastructure</CardTitle>
                <CardDescription className="mt-0.5">Control power and water utilities</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {!bridgeConnected ? (
              <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  Panel Bridge required for infrastructure control
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Current Status Display - Always visible */}
                <div className="flex items-center justify-center gap-6 p-3 bg-muted/30 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Zap className={`w-5 h-5 ${utilitiesStatus?.powerOn ? 'text-yellow-400' : 'text-muted-foreground'}`} />
                    <span className="text-sm font-medium">Power:</span>
                    <span className={`text-sm font-bold ${utilitiesStatus === null ? 'text-muted-foreground' : utilitiesStatus.powerOn ? 'text-green-400' : 'text-red-400'}`}>
                      {utilitiesStatus === null ? '...' : utilitiesStatus.powerOn ? 'ON' : 'OFF'}
                    </span>
                  </div>
                  <div className="w-px h-6 bg-border" />
                  <div className="flex items-center gap-2">
                    <Droplets className={`w-5 h-5 ${utilitiesStatus?.waterOn ? 'text-blue-400' : 'text-muted-foreground'}`} />
                    <span className="text-sm font-medium">Water:</span>
                    <span className={`text-sm font-bold ${utilitiesStatus === null ? 'text-muted-foreground' : utilitiesStatus.waterOn ? 'text-green-400' : 'text-red-400'}`}>
                      {utilitiesStatus === null ? '...' : utilitiesStatus.waterOn ? 'ON' : 'OFF'}
                    </span>
                  </div>
                </div>
                
                <p className="text-sm text-muted-foreground">
                  Restore or shut off power and water for the entire world. Note: This affects all players instantly.
                </p>
                
                <div className="grid grid-cols-2 gap-3">
                  <Button
                    variant="outline"
                    onClick={() => handleUtilitiesAction('Restore Utilities', () => panelBridgeApi.restoreUtilities())}
                    disabled={bridgeLoading !== null}
                    className="h-14 gap-2 hover:bg-green-500/10 hover:text-green-400 hover:border-green-500/30 flex-col items-center justify-center"
                  >
                    {bridgeLoading === 'Restore Utilities' ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Zap className="w-5 h-5" />
                    )}
                    <span className="text-xs">Restore Power & Water</span>
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleUtilitiesAction('Shut Off Utilities', () => panelBridgeApi.shutOffUtilities())}
                    disabled={bridgeLoading !== null}
                    className="h-14 gap-2 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 flex-col items-center justify-center"
                  >
                    {bridgeLoading === 'Shut Off Utilities' ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <CloudOff className="w-5 h-5" />
                    )}
                    <span className="text-xs">Shut Off Utilities</span>
                  </Button>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  <Button
                    variant="outline"
                    onClick={() => handleUtilitiesAction('Restore Power', () => panelBridgeApi.restoreUtilities(true, false))}
                    disabled={bridgeLoading !== null}
                    className="h-11 gap-2 hover:bg-yellow-500/10 hover:text-yellow-400"
                  >
                    {bridgeLoading === 'Restore Power' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                    Restore Power Only
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleUtilitiesAction('Restore Water', () => panelBridgeApi.restoreUtilities(false, true))}
                    disabled={bridgeLoading !== null}
                    className="h-11 gap-2 hover:bg-blue-500/10 hover:text-blue-400"
                  >
                    {bridgeLoading === 'Restore Water' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Droplets className="w-4 h-4" />}
                    Restore Water Only
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Sound Events */}
        <Card className="card-interactive">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <Volume2 className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <CardTitle className="text-lg">Sound Events</CardTitle>
                <CardDescription className="mt-0.5">Trigger sound effects that attract zombies</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              <strong>Note:</strong> Helicopter and Gunshot events target a <em>random online player</em> regardless of selection.
              Lightning and Thunder can target a specific player if selected above.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                onClick={() => handleAction('Helicopter', triggerChopper)}
                disabled={loading !== null}
                className="h-14 gap-2 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 flex-col items-center justify-center"
              >
                {loading === 'Helicopter' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Crosshair className="w-5 h-5" />}
                <span className="text-xs">Helicopter</span>
              </Button>
              <Button
                variant="outline"
                onClick={() => handleAction('Gunshot', triggerGunshot)}
                disabled={loading !== null}
                className="h-14 gap-2 hover:bg-orange-500/10 hover:text-orange-400 hover:border-orange-500/30 flex-col items-center justify-center"
              >
                {loading === 'Gunshot' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Volume2 className="w-5 h-5" />}
                <span className="text-xs">Gunshot</span>
              </Button>
              <Button
                variant="outline"
                onClick={() => handleAction('Lightning', () => triggerLightning(getTargetPlayer()))}
                disabled={loading !== null}
                className="h-14 gap-2 hover:bg-yellow-500/10 hover:text-yellow-400 hover:border-yellow-500/30 flex-col items-center justify-center"
              >
                {loading === 'Lightning' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Zap className="w-5 h-5" />}
                <span className="text-xs">Lightning</span>
              </Button>
              <Button
                variant="outline"
                onClick={() => handleAction('Thunder', () => triggerThunder(getTargetPlayer()))}
                disabled={loading !== null}
                className="h-14 gap-2 hover:bg-purple-500/10 hover:text-purple-400 hover:border-purple-500/30 flex-col items-center justify-center"
              >
                {loading === 'Thunder' ? <Loader2 className="w-5 h-5 animate-spin" /> : <CloudLightning className="w-5 h-5" />}
                <span className="text-xs">Thunder</span>
              </Button>
              <Button
                variant="outline"
                onClick={() => handleAction('Alarm', triggerAlarm)}
                disabled={loading !== null}
                className="h-14 gap-2 hover:bg-cyan-500/10 hover:text-cyan-400 hover:border-cyan-500/30 flex-col items-center justify-center col-span-2"
                title="Requires admin to be in-game - triggers at admin's location"
              >
                {loading === 'Alarm' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Bell className="w-5 h-5" />}
                <span className="text-xs">Building Alarm (Admin Location)</span>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Advanced Sound Controls (Panel Bridge v1.2.0) */}
        <Card className={`card-interactive ${!bridgeConnected ? 'opacity-60' : ''}`}>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
                <Megaphone className="w-5 h-5 text-orange-400" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-lg">Advanced Sound Controls</CardTitle>
                <CardDescription className="mt-0.5">Create sounds at specific locations to attract zombies</CardDescription>
              </div>
              {bridgeConnected && (
                <div className="flex items-center gap-1 text-emerald-500 text-sm">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  v1.2
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!bridgeConnected ? (
              <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500" />
                  Panel Bridge required for advanced sound controls
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Sound Parameters */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      <Target className="w-4 h-4 text-orange-400" />
                      Radius: {soundRadius}m
                    </Label>
                    <Slider
                      value={[soundRadius]}
                      onValueChange={([val]) => setSoundRadius(val)}
                      min={10}
                      max={300}
                      step={10}
                    />
                    <p className="text-xs text-muted-foreground">How far zombies can hear the sound</p>
                  </div>
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      <Volume2 className="w-4 h-4 text-orange-400" />
                      Volume: {soundVolume}
                    </Label>
                    <Slider
                      value={[soundVolume]}
                      onValueChange={([val]) => setSoundVolume(val)}
                      min={10}
                      max={300}
                      step={10}
                    />
                    <p className="text-xs text-muted-foreground">Intensity of the noise</p>
                  </div>
                </div>

                {/* Quick Sound Triggers (at player location) */}
                <div className="space-y-3 pt-3 border-t">
                  <Label className="flex items-center gap-2">
                    <User className="w-4 h-4" />
                    Sound at Player Location
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {targetAll 
                      ? 'Select a specific player above to trigger sounds at their location'
                      : `Sounds will trigger at ${selectedPlayer || 'selected player'}'s location`
                    }
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      variant="outline"
                      onClick={() => handleBridgeAction('Gunshot Sound', () => 
                        panelBridgeApi.triggerGunshotBridge({ username: selectedPlayer || undefined })
                      )}
                      disabled={bridgeLoading !== null || (targetAll || !selectedPlayer)}
                      className="h-12 gap-2 hover:bg-orange-500/10 hover:text-orange-400 flex-col"
                    >
                      {bridgeLoading === 'Gunshot Sound' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
                      <span className="text-xs">Gunshot</span>
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleBridgeAction('Alarm Sound', () => 
                        panelBridgeApi.triggerAlarmBridge({ username: selectedPlayer || undefined })
                      )}
                      disabled={bridgeLoading !== null || (targetAll || !selectedPlayer)}
                      className="h-12 gap-2 hover:bg-cyan-500/10 hover:text-cyan-400 flex-col"
                    >
                      {bridgeLoading === 'Alarm Sound' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
                      <span className="text-xs">Alarm</span>
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleBridgeAction('Custom Noise', () => 
                        panelBridgeApi.createNoise({ username: selectedPlayer, radius: soundRadius, volume: soundVolume })
                      )}
                      disabled={bridgeLoading !== null || (targetAll || !selectedPlayer)}
                      className="h-12 gap-2 hover:bg-purple-500/10 hover:text-purple-400 flex-col"
                    >
                      {bridgeLoading === 'Custom Noise' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Megaphone className="w-4 h-4" />}
                      <span className="text-xs">Custom</span>
                    </Button>
                  </div>
                </div>

                {/* Sound at Coordinates */}
                <div className="space-y-3 pt-3 border-t">
                  <Label className="flex items-center gap-2">
                    <MapPin className="w-4 h-4" />
                    Sound at World Coordinates
                  </Label>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">X Coordinate</Label>
                      <Input
                        type="number"
                        placeholder="e.g. 10500"
                        value={soundX}
                        onChange={(e) => setSoundX(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Y Coordinate</Label>
                      <Input
                        type="number"
                        placeholder="e.g. 9800"
                        value={soundY}
                        onChange={(e) => setSoundY(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      variant="outline"
                      onClick={() => handleBridgeAction('Gunshot at Coords', () => 
                        panelBridgeApi.triggerGunshotBridge({ x: parseInt(soundX), y: parseInt(soundY) })
                      )}
                      disabled={bridgeLoading !== null || !soundX || !soundY}
                      className="h-10 gap-2 hover:bg-orange-500/10 hover:text-orange-400"
                    >
                      {bridgeLoading === 'Gunshot at Coords' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
                      Gunshot
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleBridgeAction('Alarm at Coords', () => 
                        panelBridgeApi.triggerAlarmBridge({ x: parseInt(soundX), y: parseInt(soundY) })
                      )}
                      disabled={bridgeLoading !== null || !soundX || !soundY}
                      className="h-10 gap-2 hover:bg-cyan-500/10 hover:text-cyan-400"
                    >
                      {bridgeLoading === 'Alarm at Coords' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
                      Alarm
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleBridgeAction('Noise at Coords', () => 
                        panelBridgeApi.createNoise({ x: parseInt(soundX), y: parseInt(soundY), radius: soundRadius, volume: soundVolume })
                      )}
                      disabled={bridgeLoading !== null || !soundX || !soundY}
                      className="h-10 gap-2 hover:bg-purple-500/10 hover:text-purple-400"
                    >
                      {bridgeLoading === 'Noise at Coords' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Megaphone className="w-4 h-4" />}
                      Custom
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Zombie Events */}
        <Card className="card-interactive">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
                <Skull className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <CardTitle className="text-lg">Zombie Events</CardTitle>
                <CardDescription className="mt-0.5">Spawn zombie hordes</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Horde */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Horde Size: {hordeCount} zombies</Label>
              </div>
              <Slider
                value={[hordeCount]}
                onValueChange={([val]) => setHordeCount(val)}
                min={10}
                max={500}
                step={10}
              />
              <Button
                variant="outline"
                onClick={() => handleAction('Create horde', () => createHorde(hordeCount, getTargetPlayer()))}
                disabled={loading !== null || (!targetAll && !selectedPlayer)}
                className="w-full h-12 gap-2 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30"
              >
                {loading === 'Create horde' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Skull className="w-5 h-5" />}
                Spawn Horde Near {targetAll ? 'Random Player' : selectedPlayer || 'Selected Player'}
              </Button>
              <Button
                variant="outline"
                onClick={() => handleAction('Create horde (behind)', () => createHorde2(hordeCount, getTargetPlayer()))}
                disabled={loading !== null || (!targetAll && !selectedPlayer)}
                className="w-full h-12 gap-2 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30"
              >
                {loading === 'Create horde (behind)' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Skull className="w-5 h-5" />}
                Spawn Horde Behind {targetAll ? 'Random Player' : selectedPlayer || 'Selected Player'}
              </Button>
              <Button
                variant="destructive"
                onClick={() => handleAction('Remove all zombies', removeZombies)}
                disabled={loading !== null}
                className="w-full h-12 gap-2"
              >
                {loading === 'Remove all zombies' ? <Loader2 className="w-5 h-5 animate-spin" /> : <AlertTriangle className="w-5 h-5" />}
                Remove All Zombies
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Time Speed Control */}
        <Card className="card-interactive">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                <Clock className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <CardTitle className="text-lg">Time Speed</CardTitle>
                <CardDescription className="mt-0.5">Control the game time multiplier</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Time Speed: {timeSpeed}x</Label>
              </div>
              <Slider
                value={[timeSpeed]}
                onValueChange={([val]) => setTimeSpeed(val)}
                min={1}
                max={100}
                step={1}
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTimeSpeed(1)}
                  className={timeSpeed === 1 ? 'border-emerald-500/50 text-emerald-400' : ''}
                >
                  1x
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTimeSpeed(5)}
                  className={timeSpeed === 5 ? 'border-emerald-500/50 text-emerald-400' : ''}
                >
                  5x
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTimeSpeed(10)}
                  className={timeSpeed === 10 ? 'border-emerald-500/50 text-emerald-400' : ''}
                >
                  10x
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTimeSpeed(24)}
                  className={timeSpeed === 24 ? 'border-emerald-500/50 text-emerald-400' : ''}
                >
                  24x
                </Button>
              </div>
              <Button
                variant="outline"
                onClick={() => handleAction('Set time speed', setGameTimeSpeed)}
                disabled={loading !== null}
                className="w-full h-11 gap-2 hover:bg-emerald-500/10 hover:text-emerald-400 hover:border-emerald-500/30"
              >
                {loading === 'Set time speed' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />}
                Apply Time Speed
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Teleport */}
        <Card className="card-interactive lg:col-span-2">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center">
                <MapPin className="w-5 h-5 text-violet-400" />
              </div>
              <div>
                <CardTitle className="text-lg">Teleport</CardTitle>
                <CardDescription className="mt-0.5">Teleport players to locations or other players</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Teleport to Player */}
              <div className="space-y-4">
                <h4 className="font-medium flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  Teleport Player to Player
                </h4>
                <div className="space-y-2">
                  <Label>Select Player to Teleport</Label>
                  <Select value={selectedPlayer} onValueChange={setSelectedPlayer}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select player..." />
                    </SelectTrigger>
                    <SelectContent>
                      {players.length === 0 ? (
                        <div className="px-2 py-1.5 text-sm text-muted-foreground">No players online</div>
                      ) : (
                        players.map((player) => (
                          <SelectItem key={player.name} value={player.name}>
                            {player.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Teleport To</Label>
                  <div className="flex flex-wrap gap-2">
                    {players.filter(p => p.name !== selectedPlayer).map((player) => (
                      <Button
                        key={player.name}
                        variant="outline"
                        size="sm"
                        onClick={() => handleAction('Teleport', () => teleportPlayerToPlayer(selectedPlayer, player.name))}
                        disabled={loading !== null || !selectedPlayer}
                        className="hover:bg-violet-500/10 hover:text-violet-400 hover:border-violet-500/30"
                      >
                        {player.name}
                      </Button>
                    ))}
                    {players.length <= 1 && (
                      <p className="text-sm text-muted-foreground">Need at least 2 players online.</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Teleport to Coordinates */}
              <div className="space-y-4">
                <h4 className="font-medium flex items-center gap-2">
                  <Navigation className="w-4 h-4" />
                  Teleport to Coordinates
                </h4>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">X</Label>
                    <Input
                      type="number"
                      placeholder="10000"
                      value={teleportX}
                      onChange={(e) => setTeleportX(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Y</Label>
                    <Input
                      type="number"
                      placeholder="11000"
                      value={teleportY}
                      onChange={(e) => setTeleportY(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Z (Level)</Label>
                    <Input
                      type="number"
                      placeholder="0"
                      value={teleportZ}
                      onChange={(e) => setTeleportZ(e.target.value)}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    onClick={() => handleAction('Teleport self', () => teleportToCoords())}
                    disabled={loading !== null || !teleportX || !teleportY}
                    className="h-11 gap-2 hover:bg-violet-500/10 hover:text-violet-400 hover:border-violet-500/30"
                    title="Teleport yourself (admin must be in-game)"
                  >
                    {loading === 'Teleport self' ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPin className="w-4 h-4" />}
                    Teleport Self
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleAction('Teleport player', () => teleportToCoords(getTargetPlayer()))}
                    disabled={loading !== null || !teleportX || !teleportY || targetAll || !selectedPlayer}
                    className="h-11 gap-2 hover:bg-violet-500/10 hover:text-violet-400 hover:border-violet-500/30"
                    title="Teleport selected player to coordinates"
                  >
                    {loading === 'Teleport player' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Navigation className="w-4 h-4" />}
                    Teleport {selectedPlayer || 'Player'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Coordinates: {teleportX || '?'}, {teleportY || '?'}, {teleportZ || '0'}. 
                  Common locations: Muldraugh (10500, 9700), West Point (11800, 6900), Riverside (6500, 5300)
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Vehicle Spawning */}
        <Card className="card-interactive">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center">
                <Car className="w-5 h-5 text-cyan-400" />
              </div>
              <div>
                <CardTitle className="text-lg">🚗 Spawn Vehicle</CardTitle>
                <CardDescription className="mt-0.5">Summon vehicles for players</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Vehicle Type</Label>
              <Select value={selectedVehicle} onValueChange={setSelectedVehicle}>
                <SelectTrigger>
                  <SelectValue placeholder="Select vehicle..." />
                </SelectTrigger>
                <SelectContent>
                  {vehicles.map((vehicle) => (
                    <SelectItem key={vehicle.id} value={vehicle.id}>
                      {vehicle.icon} {vehicle.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label>Spawn for Player</Label>
              <div className="flex flex-wrap gap-2">
                {players.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No players online</p>
                ) : (
                  players.map((player) => (
                    <Button
                      key={player.name}
                      variant="outline"
                      size="sm"
                      onClick={() => handleAction('Spawn vehicle', () => spawnVehicle(selectedVehicle, player.name))}
                      disabled={loading !== null}
                      className="hover:bg-cyan-500/10 hover:text-cyan-400 hover:border-cyan-500/30"
                    >
                      <Car className="w-3 h-3 mr-1" />
                      {player.name}
                    </Button>
                  ))
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Server Announcement */}
        <Card className="card-interactive">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
                <Megaphone className="w-5 h-5 text-orange-400" />
              </div>
              <div>
                <CardTitle className="text-lg">GM Announcement</CardTitle>
                <CardDescription className="mt-0.5">Broadcast messages to all players</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Input
                placeholder="Enter your announcement..."
                value={announcement}
                onChange={(e) => setAnnouncement(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              onClick={() => handleAction('Send announcement', sendAnnouncement)}
              disabled={loading !== null || !announcement.trim()}
              className="w-full h-11 gap-2 hover:bg-orange-500/10 hover:text-orange-400 hover:border-orange-500/30"
            >
              {loading === 'Send announcement' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Megaphone className="w-4 h-4" />}
              Broadcast Message
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAnnouncement('WARNING: Event incoming!')}>
                <span className="text-yellow-500">⚠</span> Warning
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAnnouncement('Check your inventory for a surprise!')}>
                <span className="text-red-500">🎁</span> Surprise
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAnnouncement('Run! The horde is coming!')}>
                <span className="text-blue-500">🏃</span> Run!
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
