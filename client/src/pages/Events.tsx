import { useTranslation } from 'react-i18next'
import { useState, useCallback, useEffect, useRef } from 'react'
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
  Droplets,
  Sun,
  Moon,
  Eye,
  Gauge,
  RotateCcw,
  Calendar,
  Sunrise,
  Sunset,
  Wrench,
  ShieldCheck,
  Lock,
  Unlock,
  ChevronDown,
  ChevronUp,
  Check,
  X,
  Info,
  Search
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { rconApi, serverApi, playersApi, panelBridgeApi } from '@/lib/api'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { cn } from '@/lib/utils'
import { getUserErrorMessage } from '@/lib/errorMessage'

interface Player {
  name: string
  online: boolean
}

type PanelTone = 'primary' | 'warning' | 'destructive' | 'info' | 'success'

function toneBorder(tone: PanelTone): string {
  switch (tone) {
    case 'warning': return 'border-amber-400/55'
    case 'destructive': return 'border-destructive/55'
    case 'info': return 'border-info/55'
    case 'success': return 'border-emerald-400/55'
    default: return 'border-primary/55'
  }
}

function toneText(tone: PanelTone): string {
  switch (tone) {
    case 'warning': return 'text-amber-400/85'
    case 'destructive': return 'text-destructive/85'
    case 'info': return 'text-info/85'
    case 'success': return 'text-emerald-400/85'
    default: return 'text-primary/75'
  }
}

function TacticalPanel({
  children,
  tone = 'primary',
  className,
}: {
  children: React.ReactNode
  tone?: PanelTone
  className?: string
}) {
  return (
    <div className={cn(
      'self-start overflow-hidden rounded-md border bg-card shadow-sm flex flex-col',
      toneBorder(tone),
      className
    )}>
      {children}
    </div>
  )
}

function SectionHeader({
  label,
  sublabel,
  icon: Icon,
  action,
  tone = 'primary',
}: {
  label: string
  sublabel?: string
  icon?: React.ComponentType<{ className?: string }>
  action?: React.ReactNode
  tone?: PanelTone
}) {
  const isBridgeOffline = sublabel?.startsWith('bridge offline') || sublabel?.startsWith('桥接离线')
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3 select-none">
      <span className="flex min-w-0 items-center gap-2">
        {Icon && <Icon className={cn('h-4 w-4 shrink-0', toneText(tone))} />}
        <span className="truncate text-sm font-semibold text-foreground">{label}</span>
        {sublabel && (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-muted-foreground/35">/</span>
            <span className={cn(
              'truncate text-xs font-normal',
              isBridgeOffline ? 'text-amber-400/70' : 'text-muted-foreground/65'
            )}>{sublabel}</span>
          </span>
        )}
      </span>
      {action && <div className="flex items-center gap-1.5 shrink-0">{action}</div>}
    </div>
  )
}

const eventActionLabelKeys: Record<string, string> = {
  'Start rain': 'btn.startRain',
  'Stop rain': 'btn.stopRain',
  'Start storm': 'btn.startStorm',
  'Stop weather': 'btn.clearWeather',
  'Tropical Storm': 'btn.triggerTropicalStorm',
  'Blizzard': 'btn.triggerBlizzard',
  'Enable Snow': 'btn.enableSnow',
  'Disable Snow': 'btn.disableSnow',
  'Stop All Weather': 'btn.stopAllWeather',
  'Reset Climate': 'btn.reset',
  'Set Fog': 'desc.fog',
  'Set Wind': 'desc.wind',
  'Set Temperature': 'desc.temperature',
  'Set Clouds': 'desc.clouds',
  'Set Humidity': 'desc.humidity',
  'Set Precipitation': 'desc.precipitation',
  'Set Time': 'btn.applyTimeAndDate',
  'Set time speed': 'btn.applySpeed',
  'Restore Utilities': 'btn.restore',
  'Shut Off Utilities': 'btn.shutOff',
  'Restore Power': 'btn.restore',
  'Restore Water': 'btn.restore',
  'Helicopter': 'btn.helicopter',
  'Gunshot': 'btn.gunshot',
  'Lightning': 'btn.lightning',
  'Thunder': 'btn.thunder',
  'Alarm': 'btn.alarm',
  'Gunshot Sound': 'btn.gunshot',
  'Alarm Sound': 'btn.alarm',
  'Gunshot at Coords': 'btn.gunshot',
  'Alarm at Coords': 'btn.alarm',
  'Noise at Coords': 'btn.noise',
  'Custom Noise': 'btn.noise',
  'Create horde': 'labels.spawnHorde',
  'Create horde (behind)': 'labels.spawnHorde',
  'Remove all zombies': 'btn.clearLoadedZombies',
  'Teleport': 'labels.teleport',
  'Teleport self': 'btn.teleportSelf',
  'Teleport player': 'labels.teleport',
  'Spawn vehicle': 'labels.spawnVehicle',
  'Send announcement': 'btn.broadcastMessage',
  'Apply All Climate': 'btn.applyAll',
}

function getEventActionLabel(action: string, t: (key: string, options?: Record<string, unknown>) => string) {
  const key = eventActionLabelKeys[action]
  return key ? t(key) : action
}

function getEventSuccessCopy(action: string, t: any) {
  const map: Record<string, { title: string; desc: string }> = {
    'Start rain': { title: 'toast.rainStarted', desc: 'toast.rainStartedDesc' },
    'Start Rain': { title: 'toast.rainStarted', desc: 'toast.rainStartedDesc' },
    'Stop rain': { title: 'toast.rainStopped', desc: 'toast.rainStoppedDesc' },
    'Stop Rain': { title: 'toast.rainStopped', desc: 'toast.rainStoppedDesc' },
    'Start storm': { title: 'toast.stormTriggered', desc: 'toast.stormTriggeredDesc' },
    'Trigger storm': { title: 'toast.stormTriggered', desc: 'toast.stormTriggeredDesc' },
    'Tropical Storm': { title: 'toast.tropicalStormTriggered', desc: 'toast.tropicalStormTriggeredDesc' },
    'Trigger tropical storm': { title: 'toast.tropicalStormTriggered', desc: 'toast.tropicalStormTriggeredDesc' },
    'Blizzard': { title: 'toast.blizzardTriggered', desc: 'toast.blizzardTriggeredDesc' },
    'Trigger blizzard': { title: 'toast.blizzardTriggered', desc: 'toast.blizzardTriggeredDesc' },
    'Stop weather': { title: 'toast.weatherCleared', desc: 'toast.weatherClearedDesc' },
    'Stop All Weather': { title: 'toast.weatherCleared', desc: 'toast.weatherClearedDesc' },
    'Enable Snow': { title: 'toast.snowfallEnabled', desc: 'toast.snowfallEnabledDesc' },
    'Disable Snow': { title: 'toast.snowfallDisabled', desc: 'toast.snowfallDisabledDesc' },
    'Reset Climate': { title: 'toast.climateReset', desc: 'toast.climateResetDesc' },
    'Set Fog': { title: 'toast.fogUpdated', desc: 'toast.fogUpdatedDesc' },
    'Set Wind': { title: 'toast.windUpdated', desc: 'toast.windUpdatedDesc' },
    'Set Temperature': { title: 'toast.temperatureUpdated', desc: 'toast.temperatureUpdatedDesc' },
    'Set Clouds': { title: 'toast.cloudCoverUpdated', desc: 'toast.cloudCoverUpdatedDesc' },
    'Set Humidity': { title: 'toast.humidityUpdated', desc: 'toast.humidityUpdatedDesc' },
    'Set Precipitation': { title: 'toast.precipitationUpdated', desc: 'toast.precipitationUpdatedDesc' },
    'Set Time': { title: 'toast.timeUpdated', desc: 'toast.timeUpdatedDesc' },
    'Restore Utilities': { title: 'toast.utilitiesRestored', desc: 'toast.utilitiesRestoredDesc' },
    'Shut Off Utilities': { title: 'toast.utilitiesShutDown', desc: 'toast.utilitiesShutDownDesc' },
    'Restore Power': { title: 'toast.powerRestored', desc: 'toast.powerRestoredDesc' },
    'Restore Water': { title: 'toast.waterRestored', desc: 'toast.waterRestoredDesc' },
    'Helicopter': { title: 'toast.helicopterTriggered', desc: 'toast.helicopterTriggeredDesc' },
    'Gunshot': { title: 'toast.gunshotTriggered', desc: 'toast.gunshotTriggeredDesc' },
    'Gunshot Sound': { title: 'toast.gunshotTriggered', desc: 'toast.gunshotTriggeredDesc' },
    'Gunshot at Coords': { title: 'toast.gunshotTriggered', desc: 'toast.gunshotTriggeredDesc' },
    'Alarm': { title: 'toast.alarmTriggered', desc: 'toast.alarmTriggeredDesc' },
    'Alarm Sound': { title: 'toast.alarmTriggered', desc: 'toast.alarmTriggeredDesc' },
    'Alarm at Coords': { title: 'toast.alarmTriggered', desc: 'toast.alarmTriggeredDesc' },
    'Custom Noise': { title: 'toast.noiseCreated', desc: 'toast.noiseCreatedDesc' },
    'Noise at Coords': { title: 'toast.noiseCreated', desc: 'toast.noiseCreatedDesc' },
    'Lightning': { title: 'toast.lightningTriggered', desc: 'toast.lightningTriggeredDesc' },
    'Thunder': { title: 'toast.thunderTriggered', desc: 'toast.thunderTriggeredDesc' },
    'Create horde': { title: 'toast.hordeSpawned', desc: 'toast.hordeSpawnedDesc' },
    'Create horde (behind)': { title: 'toast.rearHordeSpawned', desc: 'toast.rearHordeSpawnedDesc' },
    'Remove all zombies': { title: 'toast.zombiesCleared', desc: 'toast.zombiesClearedDesc' },
    'Set time speed': { title: 'toast.timeSpeedUpdated', desc: 'toast.timeSpeedUpdatedDesc' },
    'Teleport': { title: 'toast.teleportComplete', desc: 'toast.teleportCompleteDesc' },
    'Teleport self': { title: 'toast.teleportComplete', desc: 'toast.teleportCompleteDesc' },
    'Teleport player': { title: 'toast.teleportComplete', desc: 'toast.teleportCompleteDesc' },
    'Spawn vehicle': { title: 'toast.vehicleSpawned', desc: 'toast.vehicleSpawnedDesc' },
    'Send announcement': { title: 'toast.announcementSent', desc: 'toast.announcementSentDesc' },
    'Apply All Climate': { title: 'toast.climateApplied', desc: 'toast.climateAppliedDesc' },
  }
  const entry = map[action]
  if (entry) return { title: t(entry.title), description: t(entry.desc) }
  return { title: t('toast.actionComplete'), description: t('toast.actionCompleteDesc', { action: getEventActionLabel(action, t) }) }
}

// Vehicle presets for GM
const vehicles = [
  { id: 'Base.VanAmbulance', nameKey: 'vehicleNames.ambulance' },
  { id: 'Base.PickUpVanLightsPolice', nameKey: 'vehicleNames.policeVan' },
  { id: 'Base.CarLightsPolice', nameKey: 'vehicleNames.policeCar' },
  { id: 'Base.PickUpTruckMccoy', nameKey: 'vehicleNames.pickupTruck' },
  { id: 'Base.Van', nameKey: 'vehicleNames.van' },
  { id: 'Base.ModernCar', nameKey: 'vehicleNames.modernCar' },
  { id: 'Base.SportsCar', nameKey: 'vehicleNames.sportsCar' },
  { id: 'Base.SUV', nameKey: 'vehicleNames.suv' },
  { id: 'Base.StepVan', nameKey: 'vehicleNames.stepVan' },
  { id: 'Base.Taxi', nameKey: 'vehicleNames.taxi' },
]

const bridgeOperationTemplates: Record<string, { label: string; description: string; args: string }> = {
  getSafehouses: { label: 'List Safehouses', description: 'Get all safehouses and metadata.', args: '{}' },
  safehouseAddPlayer: { label: 'Safehouse Add Player', description: 'Add a player to a safehouse.', args: '{\n  "safehouseRef": "SafehouseIdOrTitle",\n  "username": "PlayerName"\n}' },
  safehouseRemovePlayer: { label: 'Safehouse Remove Player', description: 'Remove a player from a safehouse.', args: '{\n  "safehouseRef": "SafehouseIdOrTitle",\n  "username": "PlayerName"\n}' },
  safehouseSetOwner: { label: 'Safehouse Set Owner', description: 'Transfer safehouse ownership.', args: '{\n  "safehouseRef": "SafehouseIdOrTitle",\n  "owner": "PlayerName"\n}' },
  safehouseSetRespawn: { label: 'Safehouse Respawn Toggle', description: 'Enable/disable respawn in safehouse for player.', args: '{\n  "safehouseRef": "SafehouseIdOrTitle",\n  "username": "PlayerName",\n  "enabled": true\n}' },
  getFactions: { label: 'List Factions', description: 'Get all factions and members.', args: '{}' },
  createFaction: { label: 'Create Faction', description: 'Create a new faction.', args: '{\n  "name": "FactionName",\n  "owner": "PlayerName"\n}' },
  factionAddPlayer: { label: 'Faction Add Player', description: 'Add player to faction.', args: '{\n  "factionName": "FactionName",\n  "username": "PlayerName"\n}' },
  factionRemovePlayer: { label: 'Faction Remove Player', description: 'Remove player from faction.', args: '{\n  "factionName": "FactionName",\n  "username": "PlayerName"\n}' },
  factionSetTag: { label: 'Faction Set Tag', description: 'Set short faction tag.', args: '{\n  "factionName": "FactionName",\n  "tag": "TAG"\n}' },
  removeFaction: { label: 'Remove Faction', description: 'Delete faction.', args: '{\n  "factionName": "FactionName"\n}' },
  getVehiclesDetailed: { label: 'List Vehicles', description: 'List loaded vehicles with telemetry.', args: '{}' },
  triggerSwarmEvent: { label: 'Trigger Swarm Event', description: 'Spawn zombies in rectangular area.', args: '{\n  "count": 25,\n  "x1": 10500,\n  "y1": 9800,\n  "x2": 10600,\n  "y2": 9900\n}' },
  runEventSequence: { label: 'Run Event Sequence', description: 'Run chained chat/weather/swarm/utilities/noise sequence.', args: '{\n  "steps": [\n    { "kind": "chat", "message": "Event incoming", "channel": "general" },\n    { "kind": "weather", "weatherType": "storm", "duration": 2 }\n  ]\n}' },
  getInfrastructureSnapshot: { label: 'Infrastructure Snapshot', description: 'Read hydro/weather state and optional sample point.', args: '{\n  "x": 10500,\n  "y": 9800,\n  "z": 0\n}' },

  moderationKickUser: { label: 'Kick User', description: 'Kick player via BanSystem.', args: '{\n  "username": "PlayerName",\n  "reason": "Rule violation"\n}' },
  moderationBanUser: { label: 'Ban User', description: 'Ban or unban player.', args: '{\n  "username": "PlayerName",\n  "reason": "Rule violation",\n  "ban": true\n}' },
  moderationBanIP: { label: 'Ban IP', description: 'Ban or unban IP address.', args: '{\n  "ip": "127.0.0.1",\n  "reason": "Abuse",\n  "ban": true\n}' },
  moderationBanSteamID: { label: 'Ban SteamID', description: 'Ban or unban SteamID.', args: '{\n  "steamId": "76561198000000000",\n  "reason": "Abuse",\n  "ban": true\n}' },
}

type BridgeFieldType = 'text' | 'number' | 'boolean' | 'select' | 'textarea' | 'combo'

interface BridgeFormField {
  key: string
  label: string
  type: BridgeFieldType
  required?: boolean
  placeholder?: string
  help?: string
  min?: number
  max?: number
  step?: number
  maxLength?: number
  pattern?: RegExp
  patternHint?: string
  castAs?: 'number'
  options?: Array<{ value: string; label: string }>
  defaultValue?: string
}

interface BridgeOperationForm {
  fields: BridgeFormField[]
  buildArgs?: (values: Record<string, string>) => Record<string, unknown>
}

interface BridgeResultData {
  operation: string
  success: boolean
  data: unknown
  error?: string
  timestamp: string
}
const bridgeOperationForms: Record<string, BridgeOperationForm> = {
  getSafehouses: { fields: [] },
  safehouseAddPlayer: {
    fields: [
      { key: 'safehouseRef', label: 'Safehouse', type: 'combo', required: true, placeholder: 'Select safehouse' },
      { key: 'username', label: 'Player Username', type: 'combo', required: true, placeholder: 'Select player' },
    ],
  },
  safehouseRemovePlayer: {
    fields: [
      { key: 'safehouseRef', label: 'Safehouse', type: 'combo', required: true, placeholder: 'Select safehouse' },
      { key: 'username', label: 'Player Username', type: 'combo', required: true, placeholder: 'Select player' },
    ],
  },
  safehouseSetOwner: {
    fields: [
      { key: 'safehouseRef', label: 'Safehouse', type: 'combo', required: true, placeholder: 'Select safehouse' },
      { key: 'owner', label: 'New Owner', type: 'combo', required: true, placeholder: 'Select player' },
    ],
  },
  safehouseSetRespawn: {
    fields: [
      { key: 'safehouseRef', label: 'Safehouse', type: 'combo', required: true, placeholder: 'Select safehouse' },
      { key: 'username', label: 'Player Username', type: 'combo', required: true, placeholder: 'Select player' },
      { key: 'enabled', label: 'Allow Respawn', type: 'boolean', defaultValue: 'true' },
    ],
  },
  getFactions: { fields: [] },
  createFaction: {
    fields: [
      { key: 'name', label: 'Faction Name', type: 'text', required: true, placeholder: 'FactionName', maxLength: 64 },
      { key: 'owner', label: 'Owner Username', type: 'combo', required: true, placeholder: 'Select player' },
    ],
  },
  factionAddPlayer: {
    fields: [
      { key: 'factionName', label: 'Faction Name', type: 'combo', required: true, placeholder: 'Select faction' },
      { key: 'username', label: 'Player Username', type: 'combo', required: true, placeholder: 'Select player' },
    ],
  },
  factionRemovePlayer: {
    fields: [
      { key: 'factionName', label: 'Faction Name', type: 'combo', required: true, placeholder: 'Select faction' },
      { key: 'username', label: 'Player Username', type: 'combo', required: true, placeholder: 'Select player' },
    ],
  },
  factionSetTag: {
    fields: [
      { key: 'factionName', label: 'Faction Name', type: 'combo', required: true, placeholder: 'Select faction' },
      {
        key: 'tag',
        label: 'Tag',
        type: 'text',
        required: true,
        placeholder: 'TAG',
        maxLength: 12,
        pattern: /^[A-Za-z0-9_-]{1,12}$/,
        patternHint: 'Use 1-12 characters: letters, numbers, underscore, or dash.',
      },
    ],
  },
  removeFaction: {
    fields: [
      { key: 'factionName', label: 'Faction Name', type: 'combo', required: true, placeholder: 'Select faction' },
    ],
  },
  getVehiclesDetailed: { fields: [] },
  triggerSwarmEvent: {
    fields: [
      { key: 'count', label: 'Zombie Count', type: 'number', required: true, defaultValue: '25', min: 1, max: 500 },
      { key: 'x1', label: 'X1', type: 'number', required: true, defaultValue: '10500' },
      { key: 'y1', label: 'Y1', type: 'number', required: true, defaultValue: '9800' },
      { key: 'x2', label: 'X2', type: 'number', required: true, defaultValue: '10600' },
      { key: 'y2', label: 'Y2', type: 'number', required: true, defaultValue: '9900' },
    ],
  },
  runEventSequence: {
    fields: [
      {
        key: 'preset',
        label: 'Sequence Preset',
        type: 'select',
        required: true,
        defaultValue: 'storm_alert',
        options: [
          { value: 'storm_alert', label: 'Storm Alert Sequence' },
          { value: 'panic_noise', label: 'Panic Noise Sequence' },
          { value: 'utilities_shutdown', label: 'Utilities Shutdown Sequence' },
        ],
      },
      { key: 'message', label: 'Broadcast Message', type: 'text', defaultValue: 'Event incoming', maxLength: 240 },
    ],
    buildArgs: (values) => {
      const preset = values.preset || 'storm_alert'
      const message = values.message?.trim() || 'Event incoming'

      if (preset === 'panic_noise') {
        return {
          steps: [
            { kind: 'chat', message, channel: 'general' },
            { kind: 'noise', radius: 120, volume: 100 },
          ],
        }
      }

      if (preset === 'utilities_shutdown') {
        return {
          steps: [
            { kind: 'chat', message, channel: 'general' },
            { kind: 'utilities', mode: 'off', power: true, water: true },
          ],
        }
      }

      return {
        steps: [
          { kind: 'chat', message, channel: 'general' },
          { kind: 'weather', weatherType: 'storm', duration: 2 },
        ],
      }
    },
  },
  getInfrastructureSnapshot: {
    fields: [
      { key: 'x', label: 'X (optional)', type: 'number', placeholder: '10500' },
      { key: 'y', label: 'Y (optional)', type: 'number', placeholder: '9800' },
      { key: 'z', label: 'Z (optional)', type: 'number', defaultValue: '0', placeholder: '0' },
    ],
    buildArgs: (values) => {
      const x = values.x?.trim()
      const y = values.y?.trim()
      const z = values.z?.trim()
      if (!x || !y) return {}
      return {
        x: Number(x),
        y: Number(y),
        z: z ? Number(z) : 0,
      }
    },
  },
  moderationKickUser: {
    fields: [
      { key: 'username', label: 'Username', type: 'combo', required: true, placeholder: 'Select player' },
      { key: 'reason', label: 'Reason', type: 'combo', defaultValue: 'Rule violation' },
    ],
  },
  moderationBanUser: {
    fields: [
      { key: 'username', label: 'Username', type: 'combo', required: true, placeholder: 'Select player' },
      { key: 'reason', label: 'Reason', type: 'combo', defaultValue: 'Rule violation' },
      { key: 'ban', label: 'Ban User', type: 'boolean', defaultValue: 'true' },
    ],
  },
  moderationBanIP: {
    fields: [
      {
        key: 'ip',
        label: 'IP Address',
        type: 'text',
        required: true,
        placeholder: '127.0.0.1',
        pattern: /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/,
        patternHint: 'Enter a valid IPv4 address (example: 127.0.0.1).',
      },
      { key: 'reason', label: 'Reason', type: 'combo', defaultValue: 'Abuse' },
      { key: 'ban', label: 'Ban IP', type: 'boolean', defaultValue: 'true' },
    ],
  },
  moderationBanSteamID: {
    fields: [
      {
        key: 'steamId',
        label: 'Steam ID',
        type: 'text',
        required: true,
        placeholder: '76561198000000000',
        maxLength: 17,
        pattern: /^\d{17}$/,
        patternHint: 'Steam ID must be exactly 17 digits.',
      },
      { key: 'reason', label: 'Reason', type: 'combo', defaultValue: 'Abuse' },
      { key: 'ban', label: 'Ban SteamID', type: 'boolean', defaultValue: 'true' },
    ],
  },
}

const bridgeOperationGroups = [
  {
    id: 'territory',
    label: 'Territory',
    description: 'Safehouse and faction administration.',
    operations: ['getSafehouses', 'safehouseAddPlayer', 'safehouseRemovePlayer', 'safehouseSetOwner', 'safehouseSetRespawn', 'getFactions', 'createFaction', 'factionAddPlayer', 'factionRemovePlayer', 'factionSetTag', 'removeFaction'],
  },
  {
    id: 'vehicles',
    label: 'Vehicles',
    description: 'Repair, alarms, sirens, and storage locks.',
    operations: ['getVehiclesDetailed'],
  },
  {
    id: 'events',
    label: 'Events',
    description: 'Swarm, infrastructure, and scripted sequences.',
    operations: ['triggerSwarmEvent', 'runEventSequence', 'getInfrastructureSnapshot'],
  },
  {
    id: 'moderation',
    label: 'Moderation',
    description: 'Kick and ban actions through BanSystem.',
    operations: ['moderationKickUser', 'moderationBanUser', 'moderationBanIP', 'moderationBanSteamID'],
  },
] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTranslatedBridgeOperationTemplates(t: any) {
  return Object.fromEntries(
    Object.entries(bridgeOperationTemplates).map(([key, val]) => [
      key,
      { ...val, label: t(`latest.operations.${key}.label`), description: t(`latest.operations.${key}.description`) },
    ])
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTranslatedBridgeOperationForms(t: any): Record<string, BridgeOperationForm> {
  const result: Record<string, BridgeOperationForm> = {}
  for (const [opKey, form] of Object.entries(bridgeOperationForms)) {
    result[opKey] = {
      ...form,
      fields: form.fields.map((field) => {
        const fieldKey = field.key
        const translated: BridgeFormField = { ...field }

        // Translate label: try operation-specific key first, then generic field key
        const opLabelKey = `latest.formFields.${opKey}.${fieldKey}`
        const genericLabelKey = `latest.formFields.${fieldKey}`
        const opLabel = t(opLabelKey)
        const genericLabel = t(genericLabelKey)
        if (opLabel !== opLabelKey) translated.label = opLabel
        else if (genericLabel !== genericLabelKey) translated.label = genericLabel

        // Translate placeholder
        if (field.placeholder) {
          const phKey = `${genericLabelKey}Placeholder`
          const translatedPh = t(phKey)
          translated.placeholder = translatedPh !== phKey ? translatedPh : field.placeholder
        }

        // Translate help
        if (field.help) {
          const helpKey = `${genericLabelKey}Help`
          const translatedHelp = t(helpKey)
          translated.help = translatedHelp !== helpKey ? translatedHelp : field.help
        }

        // Translate patternHint
        if (field.patternHint) {
          const hintKey = `${genericLabelKey}PatternHint`
          const translatedHint = t(hintKey)
          translated.patternHint = translatedHint !== hintKey ? translatedHint : field.patternHint
        }

        // Translate select options using formFields.<fieldKey>.<optionValue>
        if (field.options) {
          translated.options = field.options.map((opt) => {
            const opOptKey = `latest.formFields.${opKey}.${fieldKey}.${opt.value}`
            const genericOptKey = `latest.formFields.${fieldKey}.${opt.value}`
            const translatedOpOpt = t(opOptKey)
            const translatedOpt = t(genericOptKey)
            return {
              ...opt,
              label:
                translatedOpOpt !== opOptKey
                  ? translatedOpOpt
                  : translatedOpt !== genericOptKey
                    ? translatedOpt
                    : opt.label,
            }
          })
        }

        return translated
      }),
    }
  }
  return result
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTranslatedBridgeOperationGroups(t: any) {
  return bridgeOperationGroups.map((group) => ({
    ...group,
    label: t(`latest.groupLabels.${group.id}`),
    description: t(`latest.groupLabels.${group.id}Desc`),
  }))
}


const formatPanelTimestamp = (date: Date): string => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(date)
  } catch {
    return date.toLocaleString()
  }
}

// ============================================
// STRUCTURED RESULT DISPLAY
// ============================================

interface BridgeResultDisplayProps {
  t: (key: string, options?: Record<string, unknown>) => string
  result: BridgeResultData
  loading: string | null
  onInlineAction: (action: string, args: Record<string, unknown>, label: string) => Promise<void>
  players: Player[]
  translatedTemplates: Record<string, { label: string; description: string; args: string }>
}

function BridgeResultDisplay({ result, loading, onInlineAction, players, t, translatedTemplates }: BridgeResultDisplayProps) {
  const [showRaw, setShowRaw] = useState(false)
  const { operation, success, data, error, timestamp } = result
  const isLoading = loading !== null

  if (!success) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <X className="h-4 w-4" />
          {t('ui.operationFailed')}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{error || t('ui.unknownError')}</p>
        <p className="mt-1 text-xs text-muted-foreground/70">{timestamp}</p>
      </div>
    )
  }

  // Vehicle list
  if (operation === 'getVehiclesDetailed') {
    const rawVehicles = Array.isArray(data) ? data : (data as { vehicles?: unknown })?.vehicles
    const vehicles = (Array.isArray(rawVehicles) ? rawVehicles : []) as unknown[]
    if (vehicles.length === 0) {
      return (
        <ResultCard title={t('empty.noVehicles')} icon={<Car className="h-4 w-4" />} timestamp={timestamp}>
          <p className="text-sm text-muted-foreground">{t('noVehiclesAreCurrentlyLoadedInAnyActiveCell')}</p>
        </ResultCard>
      )
    }
    return (
      <div className="rounded-lg border border-border/70 bg-muted/15 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Car className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{t('ui.vehiclesLoaded', { count: vehicles.length })}</span>
          </div>
          <span className="text-xs text-muted-foreground">{timestamp}</span>
        </div>
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left">
                <th className="pb-2 pr-3 text-xs font-medium text-muted-foreground">{t('id')}</th>
                <th className="pb-2 pr-3 text-xs font-medium text-muted-foreground">{t('type')}</th>
                <th className="pb-2 pr-3 text-xs font-medium text-muted-foreground">{t('location')}</th>
                <th className="pb-2 pr-3 text-xs font-medium text-muted-foreground">{t('battery')}</th>
                <th className="pb-2 pr-3 text-xs font-medium text-muted-foreground">{t('status')}</th>
                <th className="pb-2 text-xs font-medium text-muted-foreground">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {(vehicles as Array<Record<string, unknown>>).map((v) => {
                const vid = Number(v.id)
                const script = String(v.scriptName || '').replace('Base.', '')
                const vx = Math.round(Number(v.x) || 0)
                const vy = Math.round(Number(v.y) || 0)
                const battery = Math.round((Number(v.batteryCharge) || 0) * 100)
                const alarmed = Boolean(v.alarmed)
                const sirening = Boolean(v.sirening)
                const trunkLocked = Boolean(v.trunkLocked)
                return (
                  <tr key={vid} className="border-b border-border/30 last:border-0">
                    <td className="py-2.5 pr-3 font-mono text-xs text-foreground/80">{vid}</td>
                    <td className="py-2.5 pr-3 text-xs">{script || '—'}</td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-foreground/70">{vx}, {vy}</td>
                    <td className="py-2.5 pr-3">
                      <span className={cn('text-xs font-medium', battery > 50 ? 'text-success' : battery > 20 ? 'text-warning' : 'text-destructive')}>
                        {battery}%
                      </span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-wrap gap-1">
                        {alarmed && <Badge variant="outline" className="h-5 text-[10px] px-1.5 text-warning border-warning/30">{t('ui.alarm')}</Badge>}
                        {sirening && <Badge variant="outline" className="h-5 text-[10px] px-1.5 text-info border-info/30">{t('ui.siren')}</Badge>}
                        <Badge variant="outline" className={cn('h-5 text-[10px] px-1.5', trunkLocked ? 'text-foreground/60' : 'text-success border-success/30')}>
                          {trunkLocked ? t('ui.locked') : t('ui.open')}
                        </Badge>
                      </div>
                    </td>
                    <td className="py-2.5">
                      <div className="flex flex-wrap gap-1">
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" disabled={isLoading}
                          onClick={() => onInlineAction('vehicleRepair', { vehicleId: vid }, t('ui.vehicleRepairedInline', { id: vid }))}>
                          <Wrench className="h-3 w-3" /> {t('ui.repair')}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" disabled={isLoading}
                          onClick={() => onInlineAction('vehicleSetAlarm', { vehicleId: vid, enabled: !alarmed }, alarmed ? t('ui.alarmDisabled', { id: vid }) : t('ui.alarmEnabled', { id: vid }))}>
                          {alarmed ? t('ui.alarmOff') : t('ui.alarmOn')}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" disabled={isLoading}
                          onClick={() => onInlineAction('vehicleSetTrunkLocked', { vehicleId: vid, locked: !trunkLocked }, trunkLocked ? t('ui.trunkUnlocked', { id: vid }) : t('ui.trunkLocked', { id: vid }))}>
                          {trunkLocked ? <><Unlock className="h-3 w-3" /> {t('ui.unlock')}</> : <><Lock className="h-3 w-3" /> {t('ui.lock')}</>}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  // Safehouse list
  if (operation === 'getSafehouses') {
    const rawSafehouses = Array.isArray(data) ? data : (data as { safehouses?: unknown })?.safehouses
    const safehouses = (Array.isArray(rawSafehouses) ? rawSafehouses : []) as unknown[]
    if (safehouses.length === 0) {
      return (
        <ResultCard title={t('empty.noSafehouses')} icon={<ShieldCheck className="h-4 w-4" />} timestamp={timestamp}>
          <p className="text-sm text-muted-foreground">{t('noSafehousesAreClaimedOnThisServer')}</p>
        </ResultCard>
      )
    }
    return (
      <div className="rounded-lg border border-border/70 bg-muted/15 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{t('ui.safehouseCount', { count: safehouses.length })}</span>
          </div>
          <span className="text-xs text-muted-foreground">{timestamp}</span>
        </div>
        <div className="space-y-2">
          {(safehouses as Array<Record<string, unknown>>).map((sh, i) => {
            const title = String(sh.title || sh.id || t('ui.safehouseNumber', { count: i + 1 }))
            const owner = String(sh.owner || '—')
            const members = Array.isArray(sh.members) ? sh.members : []
            const ref = String(sh.id ?? sh.title ?? '')
            return (
              <div key={ref || i} className="rounded-md border border-border/50 bg-background/40 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{t('ui.owner')}: {owner} · {t('ui.memberCount', { count: members.length })}</p>
                    {members.length > 0 && (
                      <p className="text-xs text-muted-foreground/70 mt-0.5 truncate">{t('ui.members')}: {members.map(String).join(', ')}</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {players.length > 0 && (
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={isLoading}
                        onClick={() => {
                          const username = players[0]?.name
                          if (username) onInlineAction('safehouseAddPlayer', { safehouseRef: ref, username }, t('ui.playerAddedToSafehouse', { username, title }))
                        }}>
                        {t('ui.addPlayer')}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Faction list
  if (operation === 'getFactions') {
    const rawFactions = Array.isArray(data) ? data : (data as { factions?: unknown })?.factions
    const factions = (Array.isArray(rawFactions) ? rawFactions : []) as unknown[]
    if (factions.length === 0) {
      return (
        <ResultCard title={t('empty.noFactions')} icon={<Users className="h-4 w-4" />} timestamp={timestamp}>
          <p className="text-sm text-muted-foreground">{t('noFactionsExistOnThisServer')}</p>
        </ResultCard>
      )
    }
    return (
      <div className="rounded-lg border border-border/70 bg-muted/15 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{t('ui.factionCount', { count: factions.length })}</span>
          </div>
          <span className="text-xs text-muted-foreground">{timestamp}</span>
        </div>
        <div className="space-y-2">
          {(factions as Array<Record<string, unknown>>).map((f, i) => {
            const name = String(f.name || t('ui.factionNumber', { count: i + 1 }))
            const owner = String(f.owner || '—')
            const tag = String(f.tag || '')
            const members = Array.isArray(f.members) ? f.members : []
            return (
              <div key={name} className="rounded-md border border-border/50 bg-background/40 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{name}</p>
                      {tag && <Badge variant="outline" className="h-5 text-[10px] px-1.5">{tag}</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{t('ui.owner')}: {owner} · {t('ui.memberCount', { count: members.length })}</p>
                    {members.length > 0 && (
                      <p className="text-xs text-muted-foreground/70 mt-0.5 truncate">{t('ui.members')}: {members.map(String).join(', ')}</p>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Infrastructure snapshot
  if (operation === 'getInfrastructureSnapshot') {
    const d = data as Record<string, unknown> | null
    if (!d) return <ResultCard title={t('empty.noData')} icon={<Info className="h-4 w-4" />} timestamp={timestamp}><p className="text-sm text-muted-foreground">{t('emptyResponse')}</p></ResultCard>
    return (
      <ResultCard title={t('sections.infrastructure')} icon={<Gauge className="h-4 w-4" />} timestamp={timestamp}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {Object.entries(d).filter(([k]) => k !== 'success' && k !== 'message').map(([k, v]) => (
            <div key={k} className="space-y-0.5">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{k.replace(/([A-Z])/g, ' $1').trim()}</p>
              <p className="text-sm font-medium">{typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v ?? '—')}</p>
            </div>
          ))}
        </div>
      </ResultCard>
    )
  }

  // Generic action results — extract message from common response shapes
  const msg = typeof data === 'string' ? data
    : (data as Record<string, unknown>)?.message ? String((data as Record<string, unknown>).message)
    : null

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Check className="h-4 w-4 text-primary" />
          {translatedTemplates[operation]?.label || operation}
        </div>
        <span className="text-xs text-muted-foreground">{timestamp}</span>
      </div>
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
      <button
        type="button"
        onClick={() => setShowRaw(!showRaw)}
        className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-muted-foreground transition-colors"
        aria-expanded={showRaw}
      >
        {showRaw ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {showRaw ? t('ui.hideDetails') : t('ui.showDetails')}
      </button>
      {showRaw && (
        <pre className="max-h-48 overflow-auto rounded-md border border-border/50 bg-background/60 p-2.5 text-xs font-mono whitespace-pre-wrap break-words text-muted-foreground">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  )
}

function ResultCard({ title, icon, timestamp, children }: { title: string; icon: React.ReactNode; timestamp: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/15 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-primary">{icon}</span>
          <span className="text-sm font-medium">{title}</span>
        </div>
        <span className="text-xs text-muted-foreground">{timestamp}</span>
      </div>
      {children}
    </div>
  )
}

type EventSectionKey =
  | 'rain'
  | 'severe'
  | 'climate'
  | 'clock'
  | 'timespeed'
  | 'utilities'
  | 'quickSounds'
  | 'targetedSounds'
  | 'horde'
  | 'vehicles'
  | 'teleport'
  | 'broadcast'
  | 'bridgeOps'

interface EventSectionMeta {
  id: EventSectionKey
  labelKey: string
  hintKey: string
  keywords: string
  icon: React.ComponentType<{ className?: string }>
  needsBridge: boolean
}

const EVENT_SECTION_GROUPS: Array<{ groupKey: string; items: EventSectionMeta[] }> = [
  {
    groupKey: 'weather',
    items: [
      { id: 'rain', labelKey: 'latest.eventSections.rain.label', hintKey: 'latest.eventSections.rain.hint', keywords: 'rain storm clear weather rcon', icon: CloudRain, needsBridge: false },
      { id: 'severe', labelKey: 'latest.eventSections.severe.label', hintKey: 'latest.eventSections.severe.hint', keywords: 'blizzard tropical snow severe', icon: Snowflake, needsBridge: true },
      { id: 'climate', labelKey: 'latest.eventSections.climate.label', hintKey: 'latest.eventSections.climate.hint', keywords: 'fog wind temperature clouds humidity precipitation climate', icon: Gauge, needsBridge: true },
    ],
  },
  {
    groupKey: 'world',
    items: [
      { id: 'clock', labelKey: 'latest.eventSections.clock.label', hintKey: 'latest.eventSections.clock.hint', keywords: 'time hour day month date clock dawn noon dusk midnight', icon: Calendar, needsBridge: true },
      { id: 'timespeed', labelKey: 'latest.eventSections.timespeed.label', hintKey: 'latest.eventSections.timespeed.hint', keywords: 'multiplier speed fast forward time', icon: Clock, needsBridge: true },
      { id: 'utilities', labelKey: 'latest.eventSections.utilities.label', hintKey: 'latest.eventSections.utilities.hint', keywords: 'power water utilities electricity grid shut off restore', icon: Zap, needsBridge: true },
    ],
  },
  {
    groupKey: 'sounds',
    items: [
      { id: 'quickSounds', labelKey: 'latest.eventSections.quickSounds.label', hintKey: 'latest.eventSections.quickSounds.hint', keywords: 'helicopter gunshot lightning thunder alarm noise', icon: Volume2, needsBridge: false },
      { id: 'targetedSounds', labelKey: 'latest.eventSections.targetedSounds.label', hintKey: 'latest.eventSections.targetedSounds.hint', keywords: 'noise radius volume coordinates lure targeted', icon: Megaphone, needsBridge: true },
    ],
  },
  {
    groupKey: 'players',
    items: [
      { id: 'horde', labelKey: 'latest.eventSections.horde.label', hintKey: 'latest.eventSections.horde.hint', keywords: 'horde zombies swarm spawn clear', icon: Skull, needsBridge: true },
      { id: 'vehicles', labelKey: 'latest.eventSections.vehicles.label', hintKey: 'latest.eventSections.vehicles.hint', keywords: 'vehicle car spawn', icon: Car, needsBridge: false },
      { id: 'teleport', labelKey: 'latest.eventSections.teleport.label', hintKey: 'latest.eventSections.teleport.hint', keywords: 'teleport move coordinates warp', icon: MapPin, needsBridge: false },
      { id: 'broadcast', labelKey: 'latest.eventSections.broadcast.label', hintKey: 'latest.eventSections.broadcast.hint', keywords: 'announcement broadcast message chat warning', icon: Bell, needsBridge: false },
    ],
  },
  {
    groupKey: 'advanced',
    items: [
      { id: 'bridgeOps', labelKey: 'latest.eventSections.bridgeOps.label', hintKey: 'latest.eventSections.bridgeOps.hint', keywords: 'safehouse faction moderation kick ban operations advanced bridge', icon: Crosshair, needsBridge: true },
    ],
  },
]

function getTranslatedEventSectionGroups(t: any) {
  return EVENT_SECTION_GROUPS.map((group) => ({
    group: t(`latest.eventGroups.${group.groupKey}`),
    items: group.items.map((item) => ({
      ...item,
      label: t(item.labelKey),
      hint: t(item.hintKey),
    })),
  }))
}

// Sections whose commands act on a chosen player rather than the whole world.
const TARGETED_SECTIONS: EventSectionKey[] = ['quickSounds', 'targetedSounds', 'horde', 'teleport']

interface ActivityEntry {
  key: number
  label: string
  ok: boolean
  at: string
}

export default function Events() {
  const { t } = useTranslation('events')
  const translatedTemplates = getTranslatedBridgeOperationTemplates(t)
  const translatedForms = getTranslatedBridgeOperationForms(t)
  const translatedGroups = getTranslatedBridgeOperationGroups(t)
  const translatedEventGroups = getTranslatedEventSectionGroups(t)
  const translatedEventIndex: Record<EventSectionKey, EventSectionMeta & { label: string; hint: string }> = Object.fromEntries(
    translatedEventGroups.flatMap((group) => group.items.map((item) => [item.id, item]))
  ) as Record<EventSectionKey, EventSectionMeta & { label: string; hint: string }>

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

  // Climate controls
  const [fogIntensity, setFogIntensity] = useState(0)
  const [windIntensity, setWindIntensity] = useState(0)
  const [temperature, setTemperature] = useState(20)
  const [cloudIntensity, setCloudIntensity] = useState(0)
  const [humidity, setHumidity] = useState(50)
  const [precipitationIntensity, setPrecipitationIntensity] = useState(0)

  // Game time controls
  const [gameHour, setGameHour] = useState(12)
  const [gameDay, setGameDay] = useState(1)
  const [gameMonth, setGameMonth] = useState(7)

  // Sound controls
  const [soundRadius, setSoundRadius] = useState(100)
  const [soundVolume, setSoundVolume] = useState(100)
  const [soundX, setSoundX] = useState('')
  const [soundY, setSoundY] = useState('')

  // Bridge operations (new Lua handlers)
  const [bridgeOperation, setBridgeOperation] = useState<string>('getSafehouses')
  const [bridgeOperationFormValues, setBridgeOperationFormValues] = useState<Record<string, Record<string, string>>>(() => {
    return Object.fromEntries(
      Object.entries(translatedForms).map(([operation, form]) => {
        const seeded = Object.fromEntries(form.fields.map((field) => [field.key, field.defaultValue ?? '']))
        return [operation, seeded]
      })
    )
  })
  const [bridgeResultData, setBridgeResultData] = useState<BridgeResultData | null>(null)
  const [bridgeFormError, setBridgeFormError] = useState<string | null>(null)
  const [bridgeLastRunAt, setBridgeLastRunAt] = useState<string | null>(null)
  const [bridgeSafehouseOptions, setBridgeSafehouseOptions] = useState<Array<{ value: string; label: string }>>([])
  const [bridgeFactionOptions, setBridgeFactionOptions] = useState<Array<{ value: string; label: string }>>([])
  const [bridgeVehicleOptions, setBridgeVehicleOptions] = useState<Array<{ value: string; label: string }>>([])
  const [bridgeOptionsLoading, setBridgeOptionsLoading] = useState(false)
  const [bridgeOptionsError, setBridgeOptionsError] = useState<string | null>(null)
  const [bridgeOptionsLastUpdated, setBridgeOptionsLastUpdated] = useState<string | null>(null)
  const [bridgeOptionsRefreshTick, setBridgeOptionsRefreshTick] = useState(0)
  const [bridgeConnectionSummary, setBridgeConnectionSummary] = useState<string | null>(null)

  // Utilities status
  const [utilitiesStatus, setUtilitiesStatus] = useState<{
    hydroPowerOn: boolean
    powerOn: boolean
    waterOn: boolean
    elecShut: string
    waterShut: string
  } | null>(null)

  const { toast } = useToast()

  const [activeSection, setActiveSection] = useState<EventSectionKey>('rain')
  const [sectionQuery, setSectionQuery] = useState('')
  const [activity, setActivity] = useState<ActivityEntry[]>([])

  const fetchPlayers = useCallback(async () => {
    try {
      const data = await playersApi.getPlayers()
      if (data.players) {
        setPlayers(data.players)
      }
    } catch {
      // Silently ignore — player list will refresh on next interval
    }
  }, [])

  const mountedRef = useRef(true)
  // Suppress climate-slider overwrites from the 10s bridge poll while the
  // user is actively dragging or has just released a slider. Updated by
  // onValueChange on each climate Slider; cleared on apply/reset so the
  // next poll picks up authoritative game state.
  const climateDirtyUntilRef = useRef(0)
  const markClimateDirty = useCallback(() => {
    climateDirtyUntilRef.current = Date.now() + 2500
  }, [])

  const checkBridgeStatus = useCallback(async () => {
    try {
      const status = await panelBridgeApi.getStatus()
      if (!mountedRef.current) return
      setBridgeConnected(status.modConnected)
      setBridgeConnectionSummary(status.connection?.summary || null)

      // If connected, fetch secondary data in parallel
      if (status.modConnected) {
        const [floatsRes, timeRes, utilitiesRes] = await Promise.allSettled([
          panelBridgeApi.getClimateFloats(),
          panelBridgeApi.getGameTime(),
          panelBridgeApi.getUtilitiesStatus(),
        ])
        if (!mountedRef.current) return

        if (floatsRes.status === 'fulfilled' && floatsRes.value.success && floatsRes.value.data?.floats) {
          // Don't clobber sliders the user is currently dragging.
          if (Date.now() >= climateDirtyUntilRef.current) {
            const floats = floatsRes.value.data.floats
            const findFloat = (id: number) => floats.find((f: { id: number; value: number }) => f.id === id)?.value
            setFogIntensity(Math.round((findFloat(5) ?? 0) * 100))
            setWindIntensity(Math.round((findFloat(6) ?? 0) * 100))
            setTemperature(Math.round(findFloat(4) ?? 20))
            setCloudIntensity(Math.round((findFloat(8) ?? 0) * 100))
            setHumidity(Math.round((findFloat(12) ?? 0.5) * 100))
            setPrecipitationIntensity(Math.round((findFloat(3) ?? 0) * 100))
          }
        }

        if (timeRes.status === 'fulfilled' && timeRes.value.success && timeRes.value.data) {
          setGameHour(Math.floor(timeRes.value.data.hour))
          setGameDay(timeRes.value.data.day)
          setGameMonth(timeRes.value.data.month)
        }

        if (utilitiesRes.status === 'fulfilled' && utilitiesRes.value.success && utilitiesRes.value.data) {
          setUtilitiesStatus(utilitiesRes.value.data)
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        setBridgeConnected(false)
        setBridgeConnectionSummary(t('latest.unableToReadBridgeStatus'))
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    fetchPlayers()
    checkBridgeStatus()
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') fetchPlayers()
    }, 30000)
    const bridgeInterval = setInterval(() => {
      if (document.visibilityState !== 'hidden') checkBridgeStatus()
    }, 10000)
    return () => {
      mountedRef.current = false
      clearInterval(interval)
      clearInterval(bridgeInterval)
    }
  }, [fetchPlayers, checkBridgeStatus])

  useEffect(() => {
    if (!bridgeConnected) {
      setBridgeSafehouseOptions([])
      setBridgeFactionOptions([])
      setBridgeVehicleOptions([])
      setBridgeOptionsLoading(false)
      setBridgeOptionsError(null)
      setBridgeOptionsLastUpdated(null)
      return
    }

    let active = true
    const loadBridgeOptions = async () => {
      setBridgeOptionsLoading(true)
      try {
        const [safehouseResult, factionResult, vehicleResult] = await Promise.allSettled([
          panelBridgeApi.sendCommand('getSafehouses', {}),
          panelBridgeApi.sendCommand('getFactions', {}),
          panelBridgeApi.sendCommand('getVehiclesDetailed', {}),
        ])
        if (!active) return

        const failureReasons: string[] = []
        let updatedAnySource = false

        if (safehouseResult.status === 'fulfilled') {
          const safehousePayload = (safehouseResult.value as { data?: unknown })?.data ?? safehouseResult.value
          const rawSafehouses = Array.isArray(safehousePayload)
            ? safehousePayload
            : (safehousePayload as { safehouses?: unknown })?.safehouses
          const safehouses = (Array.isArray(rawSafehouses) ? rawSafehouses : []) as Array<{ id?: unknown; title?: unknown }>
          const safehouseOptions = safehouses
            .map((safehouse) => {
              const id = safehouse.id != null ? String(safehouse.id).trim() : ''
              const title = safehouse.title != null ? String(safehouse.title).trim() : ''
              const value = id || title
              if (!value) return null
              const label = title ? `${title}${id ? ` (${id})` : ''}` : value
              return { value, label }
            })
            .filter((option): option is { value: string; label: string } => Boolean(option))
          const dedupedSafehouses = Array.from(new Map(safehouseOptions.map((option) => [option.value, option])).values())
          setBridgeSafehouseOptions(dedupedSafehouses)
          updatedAnySource = true
        } else {
          failureReasons.push('safehouses')
        }

        if (factionResult.status === 'fulfilled') {
          const factionPayload = (factionResult.value as { data?: unknown })?.data ?? factionResult.value
          const rawFactions = Array.isArray(factionPayload)
            ? factionPayload
            : (factionPayload as { factions?: unknown })?.factions
          const factions = (Array.isArray(rawFactions) ? rawFactions : []) as Array<{ name?: unknown; owner?: unknown }>
          const factionOptions = factions
            .map((faction) => {
              const name = faction.name != null ? String(faction.name).trim() : ''
              if (!name) return null
              const owner = faction.owner != null ? String(faction.owner).trim() : ''
              return { value: name, label: owner ? `${name} (owner: ${owner})` : name }
            })
            .filter((option): option is { value: string; label: string } => Boolean(option))
          const dedupedFactions = Array.from(new Map(factionOptions.map((option) => [option.value, option])).values())
          setBridgeFactionOptions(dedupedFactions)
          updatedAnySource = true
        } else {
          failureReasons.push('factions')
        }

        if (vehicleResult.status === 'fulfilled') {
          const vehiclePayload = (vehicleResult.value as { data?: unknown })?.data ?? vehicleResult.value
          const rawVehicles = Array.isArray(vehiclePayload)
            ? vehiclePayload
            : (vehiclePayload as { vehicles?: unknown })?.vehicles
          const vehicles = (Array.isArray(rawVehicles) ? rawVehicles : []) as Array<{ id?: unknown; scriptName?: unknown; x?: unknown; y?: unknown }>
          const vehicleOptions = vehicles
            .map((vehicle) => {
              const id = vehicle.id != null ? String(vehicle.id).trim() : ''
              if (!id) return null
              const script = vehicle.scriptName != null ? String(vehicle.scriptName).trim() : ''
              const x = vehicle.x != null ? String(vehicle.x).trim() : ''
              const y = vehicle.y != null ? String(vehicle.y).trim() : ''
              const coord = x && y ? ` @ ${x},${y}` : ''
              const label = `${id}${script ? ` (${script})` : ''}${coord}`
              return { value: id, label }
            })
            .filter((option): option is { value: string; label: string } => Boolean(option))
          const dedupedVehicles = Array.from(new Map(vehicleOptions.map((option) => [option.value, option])).values())
          setBridgeVehicleOptions(dedupedVehicles)
          updatedAnySource = true
        } else {
          failureReasons.push('vehicles')
        }

        if (failureReasons.length > 0) {
          setBridgeOptionsError(
            failureReasons.length === 3
              ? t('latest.bridgeOptionsRefreshFailed')
              : t('latest.someBridgeListsFailed', { count: failureReasons.length })
          )
        } else {
          setBridgeOptionsError(null)
        }

        if (updatedAnySource) {
          setBridgeOptionsLastUpdated(formatPanelTimestamp(new Date()))
        }
      } catch {
        if (!active) return
        setBridgeOptionsError(t('latest.bridgeOptionsRefreshFailed'))
      } finally {
        if (active) setBridgeOptionsLoading(false)
      }
    }

    void loadBridgeOptions()
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void loadBridgeOptions()
    }, 30000)

    return () => {
      active = false
      clearInterval(interval)
    }
  }, [bridgeConnected, bridgeOptionsRefreshTick, t])

  const pushActivity = useCallback((label: string, ok: boolean) => {
    setActivity((prev) => [
      { key: Date.now() + Math.random(), label, ok, at: formatPanelTimestamp(new Date()) },
      ...prev,
    ].slice(0, 6))
  }, [])

  // Bridge weather commands
  const handleBridgeAction = useCallback(async (action: string, fn: () => Promise<unknown>) => {
    setBridgeLoading(action)
    try {
      await fn()
      const successCopy = getEventSuccessCopy(action, t)
      toast({
        title: successCopy.title,
        description: successCopy.description,
        variant: 'success' as const,
      })
      pushActivity(successCopy.title, true)
    } catch (error) {
      const message = getUserErrorMessage(error, t('ui.bridgeCommandFailed'))
      toast({
        title: t('toast.actionFailed', { action: getEventActionLabel(action, t) }),
        description: `${message}. Check bridge/server connection and try again.`,
        variant: 'destructive',
      })
      pushActivity(t('toast.actionFailed', { action: getEventActionLabel(action, t) }), false)
    } finally {
      setBridgeLoading(null)
    }
  }, [toast, pushActivity])

  const executeCommand = useCallback(async (command: string) => {
    const result = await rconApi.execute(command)
    if (!result.success) {
      throw new Error(result.error || 'Command failed')
    }
    return result
  }, [])

  const handleAction = useCallback(async (action: string, fn: () => Promise<unknown>) => {
    setLoading(action)
    try {
      await fn()
      const successCopy = getEventSuccessCopy(action, t)
      toast({
        title: successCopy.title,
        description: successCopy.description,
        variant: 'success' as const,
      })
      pushActivity(successCopy.title, true)
    } catch (error) {
      const message = getUserErrorMessage(error, t('ui.commandFailed'))
      toast({
        title: t('toast.actionFailed', { action: getEventActionLabel(action, t) }),
        description: `${message}. Verify command settings and try again.`,
        variant: 'destructive',
      })
      pushActivity(t('toast.actionFailed', { action: getEventActionLabel(action, t) }), false)
    } finally {
      setLoading(null)
    }
  }, [toast, pushActivity])

  const handleUtilities = useCallback(async (action: string, on: boolean, power: boolean, water: boolean) => {
    setLoading(action)
    try {
      const result = on
        ? await panelBridgeApi.restoreUtilities(power, water)
        : await panelBridgeApi.shutOffUtilities(power, water)
      await checkBridgeStatus()
      const successCopy = getEventSuccessCopy(action, t)
      const notPersisted = result?.persisted === false
      toast({
        title: successCopy.title,
        description: notPersisted
          ? t('ui.utilitiesNotPersisted', { reason: result.persistReason || t('ui.unknownReason') })
          : successCopy.description,
        variant: notPersisted ? 'default' : ('success' as const),
      })
      pushActivity(successCopy.title, true)
    } catch (error) {
      const message = getUserErrorMessage(error, t('ui.commandFailed'))
      toast({
        title: t('toast.actionFailed', { action: getEventActionLabel(action, t) }),
        description: `${message}. Verify command settings and try again.`,
        variant: 'destructive',
      })
      pushActivity(t('toast.actionFailed', { action: getEventActionLabel(action, t) }), false)
    } finally {
      setLoading(null)
    }
  }, [toast, checkBridgeStatus, pushActivity])

  const getTargetPlayer = useCallback(() => targetAll ? undefined : selectedPlayer || undefined, [targetAll, selectedPlayer])

  const parseCoord = (value: string): number | null => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.floor(n) : null
  }

  const soundCoordX = parseCoord(soundX)
  const soundCoordY = parseCoord(soundY)
  const hasValidSoundCoords = soundCoordX !== null && soundCoordY !== null

  const teleportCoordX = parseCoord(teleportX)
  const teleportCoordY = parseCoord(teleportY)
  const teleportCoordZ = parseCoord(teleportZ)
  const hasValidTeleportCoords = teleportCoordX !== null && teleportCoordY !== null && teleportCoordZ !== null

  // Weather commands
  const startRain = () => serverApi.startRain(rainIntensity / 100)
  const stopRain = () => serverApi.stopRain()
  const startStorm = () => serverApi.startStorm(stormDuration)
  const stopWeather = () => serverApi.stopWeather()

  // Sound/Event commands
  // Note: chopper and gunshot target a RANDOM online player, not the selected player
  const triggerChopper = () => serverApi.triggerChopper()
  const triggerGunshot = () => serverApi.triggerGunshot()
  const triggerLightning = (username?: string) => serverApi.triggerLightning(username)
  const triggerThunder = (username?: string) => serverApi.triggerThunder(username)
  // Alarm triggers at admin's in-game position (admin must be online)
  const triggerAlarm = () => serverApi.alarm()

  // PZ RCON `lightning` / `thunder` require a username and silently no-op without one.
  // If the user has "all online" selected, pick a random connected player instead
  // of sending an empty command.
  const pickStrikeTarget = (): string => {
    const explicit = getTargetPlayer()
    if (explicit) return explicit
    if (players.length === 0) throw new Error(t('ui.noPlayersOnline'))
    return players[Math.floor(Math.random() * players.length)].name
  }

  // Zombie commands — use PanelBridge (CreateSwarm) for proper distance control
  const createHorde = (count: number, username?: string) => {
    if (!username) throw new Error(t('ui.hordeTargetRequired'))
    return panelBridgeApi.spawnHordeNear(username, count)
  }

  // Spawn horde behind the player based on their facing direction
  const createHorde2 = (count: number, username?: string) => {
    if (!username) throw new Error(t('ui.hordeTargetRequired'))
    return panelBridgeApi.spawnHordeBehind(username, count)
  }

  // Clear all zombies from loaded cells
  const removeZombies = () => panelBridgeApi.clearAllZombies()

  // Time commands
  // Routed through the bridge rather than RCON `setTimeSpeed` so the change is
  // applied and read back with the rest of the climate/time state.
  const setGameTimeSpeed = () => panelBridgeApi.sendCommand('setTimeSpeed', { multiplier: timeSpeed })

  // Teleport commands
  // teleportto only works if admin is in-game and teleports themselves
  // For teleporting other players, use teleport command with player name and coordinates
  const teleportToCoords = (x: number, y: number, z: number, targetPlayer?: string) => {
    if (targetPlayer) {
      // Teleport specific player to coordinates
      return executeCommand(`teleport "${targetPlayer}" ${x},${y},${z}`)
    }
    // Self-teleport (requires admin to be in-game)
    return executeCommand(`teleportto ${x},${y},${z}`)
  }
  const teleportPlayerToPlayer = (player1: string, player2: string) =>
    executeCommand(`teleport "${player1}" "${player2}"`)

  // Vehicle commands
  const spawnVehicle = (vehicleId: string, username: string) =>
    executeCommand(`addvehicle "${vehicleId}" "${username}"`)

  // Announcement
  const sendAnnouncement = () => serverApi.sendMessage(announcement)

  const getBridgeFieldValue = (fieldKey: string): string => bridgeOperationFormValues[bridgeOperation]?.[fieldKey] ?? ''

  const setBridgeFieldValue = (fieldKey: string, value: string) => {
    setBridgeOperationFormValues((prev) => ({
      ...prev,
      [bridgeOperation]: {
        ...(prev[bridgeOperation] ?? {}),
        [fieldKey]: value,
      },
    }))
    if (bridgeFormError) setBridgeFormError(null)
  }

  const buildBridgeArgsFromForm = (operation: string): Record<string, unknown> => {
    const form = translatedForms[operation]
    if (!form || form.fields.length === 0) return {}

    const values = bridgeOperationFormValues[operation] ?? {}
    const missingRequired = form.fields.find((field) => field.required && !String(values[field.key] ?? '').trim())
    if (missingRequired) {
      throw new Error(`${missingRequired.label} is required.`)
    }

    if (form.buildArgs) {
      return form.buildArgs(values)
    }

    const args: Record<string, unknown> = {}
    for (const field of form.fields) {
      const raw = values[field.key] ?? ''
      const trimmed = raw.trim()
      if (!trimmed && !field.required) continue

      if (field.type === 'number' || field.castAs === 'number') {
        const n = Number(trimmed)
        if (!Number.isFinite(n)) {
          throw new Error(`${field.label} must be a valid number.`)
        }
        if (typeof field.min === 'number' && n < field.min) {
          throw new Error(`${field.label} must be at least ${field.min}.`)
        }
        if (typeof field.max === 'number' && n > field.max) {
          throw new Error(`${field.label} must be at most ${field.max}.`)
        }
        args[field.key] = n
      } else if (field.type === 'boolean') {
        args[field.key] = trimmed === 'true'
      } else {
        if (typeof field.maxLength === 'number' && trimmed.length > field.maxLength) {
          throw new Error(`${field.label} must be ${field.maxLength} characters or fewer.`)
        }
        if (field.pattern && !field.pattern.test(trimmed)) {
          throw new Error(field.patternHint || `${field.label} is not in the expected format.`)
        }
        args[field.key] = trimmed
      }
    }

    return args
  }

  const bridgeActiveGroup = translatedGroups.find((group) => (group.operations as readonly string[]).includes(bridgeOperation))
  const currentBridgeForm = translatedForms[bridgeOperation]
  const currentBridgeFields = currentBridgeForm?.fields ?? []
  const currentBridgeHasComboFields = currentBridgeFields.some((field) => field.type === 'combo')
  const currentRequiredFieldCount = currentBridgeFields.filter((field) => field.required).length
  const currentCompletedRequiredFieldCount = currentBridgeFields.filter((field) => {
    if (!field.required) return false
    return Boolean(getBridgeFieldValue(field.key).trim())
  }).length
  const bridgeRunDisabledReason = !bridgeConnected
    ? t('ui.bridgeIsOffline')
    : bridgeLoading !== null
      ? t('ui.operationInProgress')
      : bridgeFormError
        ? bridgeFormError
        : null

  const selectBridgeOperation = (nextOperation: string) => {
    setBridgeOperation(nextOperation)
    setBridgeFormError(null)
    setBridgeResultData(null)
    setBridgeLastRunAt(null)
  }

  const getBridgeComboOptions = (fieldKey: string): Array<{ value: string; label: string }> => {
    if (fieldKey === 'username' || fieldKey === 'owner') {
      return players.map((player) => ({ value: player.name, label: player.name }))
    }

    if (fieldKey === 'safehouseRef') {
      return bridgeSafehouseOptions
    }

    if (fieldKey === 'factionName') {
      return bridgeFactionOptions
    }

    if (fieldKey === 'vehicleId') {
      return bridgeVehicleOptions
    }

    if (fieldKey === 'reason') {
      return [
        { value: 'Rule violation', label: 'Rule violation' },
        { value: 'Abuse', label: 'Abuse' },
        { value: 'Harassment', label: 'Harassment' },
        { value: 'Cheating', label: 'Cheating' },
      ]
    }

    return []
  }

  const resetBridgeFormValues = () => {
    const form = translatedForms[bridgeOperation]
    if (!form) return
    const defaults = Object.fromEntries(form.fields.map((field) => [field.key, field.defaultValue ?? '']))
    setBridgeOperationFormValues((prev) => ({ ...prev, [bridgeOperation]: defaults }))
    setBridgeFormError(null)
  }

  const runInlineAction = async (action: string, args: Record<string, unknown>, label: string) => {
    setBridgeLoading(action)
    try {
      await panelBridgeApi.sendCommand(action, args)
      toast({
        title: `${label}`,
        description: t('ui.operationCompleted'),
        variant: 'success' as const,
      })
      // Re-run the current list operation to refresh table data
      if (bridgeResultData?.operation) {
        try {
          const refreshed = await panelBridgeApi.sendCommand(bridgeResultData.operation, {})
          const payload = (refreshed as Record<string, unknown>)?.data ?? refreshed
          setBridgeResultData({
            operation: bridgeResultData.operation,
            success: true,
            data: payload,
            timestamp: formatPanelTimestamp(new Date()),
          })
        } catch { /* ignore refresh failure */ }
      }
      // Also refresh combo options
      setBridgeOptionsRefreshTick((prev) => prev + 1)
    } catch (error) {
      toast({
        title: t('toast.actionFailed', { action: label }),
        description: getUserErrorMessage(error, t('ui.operationFailed')),
        variant: 'destructive',
      })
    } finally {
      setBridgeLoading(null)
    }
  }

  const runBridgeOperation = async () => {
    if (!bridgeConnected) {
      toast({
        title: t('ui.bridgeNotConnected'),
        description: t('ui.bridgeNotConnectedDesc'),
        variant: 'destructive',
      })
      return
    }

    let parsedArgs: Record<string, unknown> = {}
    try {
      parsedArgs = buildBridgeArgsFromForm(bridgeOperation)
      setBridgeFormError(null)
    } catch (error) {
      const message = getUserErrorMessage(error, t('ui.completeRequiredFields'))
      setBridgeFormError(message)
      toast({
        title: t('ui.missingOrInvalidFields'),
        description: message,
        variant: 'destructive',
      })
      return
    }

    setBridgeLoading(bridgeOperation)
    setBridgeFormError(null)
    try {
      const response = await panelBridgeApi.sendCommand(bridgeOperation, parsedArgs)
      const payload = (response as Record<string, unknown>)?.data ?? response
      setBridgeResultData({
        operation: bridgeOperation,
        success: true,
        data: payload,
        timestamp: formatPanelTimestamp(new Date()),
      })
      setBridgeLastRunAt(formatPanelTimestamp(new Date()))
      // Refresh combo options for list operations
      if (['getSafehouses', 'getFactions', 'getVehiclesDetailed'].includes(bridgeOperation)) {
        setBridgeOptionsRefreshTick((prev) => prev + 1)
      }
      toast({
        title: t('latest.operationExecuted', { operation: translatedTemplates[bridgeOperation]?.label || bridgeOperation }),
        description: t('ui.operationCompleted'),
        variant: 'success' as const,
      })
    } catch (error) {
      const message = getUserErrorMessage(error, t('ui.bridgeOperationFailed'))
      setBridgeResultData({
        operation: bridgeOperation,
        success: false,
        data: null,
        error: message,
        timestamp: formatPanelTimestamp(new Date()),
      })
      setBridgeLastRunAt(formatPanelTimestamp(new Date()))
      toast({
        title: t('ui.bridgeOperationFailed'),
        description: message,
        variant: 'destructive',
      })
    } finally {
      setBridgeLoading(null)
    }
  }

  const normalizedQuery = sectionQuery.trim().toLowerCase()
  const filteredGroups = translatedEventGroups
    .map((group) => ({
      group: group.group,
      items: normalizedQuery
        ? group.items.filter((item) =>
            `${item.label} ${item.hint} ${item.keywords} ${group.group}`.toLowerCase().includes(normalizedQuery)
          )
        : group.items,
    }))
    .filter((group) => group.items.length > 0)
  const activeMeta = translatedEventIndex[activeSection]

  return (
    <div className="mx-auto max-w-[1180px] space-y-5 pb-8 page-transition">
      <PageHeader
        title={t('sections.eventConsole')}
        description={t('description')}
        eyebrow={t('ui.worldControl')}
        tone="world"
        icon={<Zap className="w-5 h-5 text-primary" />}
        actions={
          <Button variant="command" onClick={fetchPlayers} className="gap-2 h-9 text-xs font-medium">
            <RefreshCw className="w-3.5 h-3.5" />
            {t('ui.refreshPlayers')}
          </Button>
        }
      />

      {/* Scope and connection state stay visible before event controls. */}
      <div className={cn(
        'rounded-md border bg-card px-4 py-3',
        bridgeConnected ? 'border-border/70' : 'border-amber-400/55'
      )}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Bridge status */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
              <Zap className={cn('w-3.5 h-3.5', bridgeConnected ? 'text-primary' : 'text-amber-400')} />
              <span>{t('bridge')}</span>
            </div>
            <div className={cn(
              'flex items-center gap-2 px-2.5 py-1 rounded-md border',
              bridgeConnected
                ? 'border-emerald-400/30 bg-emerald-400/10'
                : 'border-amber-400/30 bg-amber-400/10'
            )}>
              <span className={cn(
                'w-2 h-2 rounded-full shadow-[0_0_8px_currentColor]',
                bridgeConnected ? 'bg-emerald-400 text-emerald-400 animate-pulse' : 'bg-amber-400 text-amber-400'
              )} />
              <span className={cn(
                'text-sm font-semibold',
                bridgeConnected ? 'text-emerald-300' : 'text-amber-300'
              )}>
                {bridgeConnected ? t('ui.online') : t('ui.offline')}
              </span>
            </div>
            {!bridgeConnected && (
              <Link to="/settings" className="hidden sm:inline-flex text-sm font-medium text-primary hover:text-primary/80 underline-offset-2 hover:underline">
                {t('ui.configure')}
              </Link>
            )}
          </div>

          {/* Target picker — only for sections whose commands act on a chosen player. */}
          <div className="flex flex-wrap items-center gap-3">
            {TARGETED_SECTIONS.includes(activeSection) && (
              <>
                <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
                  {t('ui.target')}
            </span>
            <div className="inline-flex rounded-md border border-border/70 bg-background/60 p-0.5 shadow-sm">
              <button
                type="button"
                onClick={() => setTargetAll(true)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium rounded-sm transition-colors',
                  targetAll
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-background/40'
                )}
                aria-pressed={targetAll}
              >
                {t('ui.allOnline')}
              </button>
              <button
                type="button"
                onClick={() => setTargetAll(false)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium rounded-sm transition-colors',
                  !targetAll
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-background/40'
                )}
                aria-pressed={!targetAll}
              >
                {t('ui.specific')}
              </button>
            </div>
            {!targetAll && (
              <Select value={selectedPlayer} onValueChange={setSelectedPlayer}>
                <SelectTrigger id="event-target-player" aria-label={t('labels.selectPlayer')} className="h-9 w-[210px] font-mono text-xs">
                  <SelectValue placeholder={t('placeholders.selectPlayer')} />
                </SelectTrigger>
                <SelectContent>
                  {players.length === 0 ? (
                    <div className="px-2 py-1.5 font-mono text-[11px] text-muted-foreground">{t('ui.noPlayersOnline')}</div>
                  ) : (
                    players.map((player) => (
                      <SelectItem key={player.name} value={player.name}>
                        <span className="block max-w-[200px] truncate" dir="auto" title={player.name}>{player.name}</span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            )}
              </>
            )}
            <div className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-md border whitespace-nowrap',
              players.length > 0
                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                : 'border-border/60 bg-muted/30 text-muted-foreground'
            )}>
              <Users className="w-3.5 h-3.5" />
              <span className="text-sm font-bold tabular-nums">{players.length}</span>
              <span className="text-xs font-medium opacity-80">{t('ui.online')}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={sectionQuery}
              onChange={(e) => setSectionQuery(e.target.value)}
              placeholder={t('latest.findControl')}
              aria-label={t('latest.findEventControl')}
              className="h-9 pl-8 text-sm"
            />
          </div>

          <nav aria-label={t('latest.eventSections')} className="space-y-3 rounded-md border border-border/60 bg-card p-2">
            {filteredGroups.map((group) => (
              <div key={group.group}>
                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
                  {group.group}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon
                    const isActive = item.id === activeSection
                    const blocked = item.needsBridge && !bridgeConnected
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setActiveSection(item.id)}
                        aria-current={isActive ? 'true' : undefined}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors',
                          isActive
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                        )}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {blocked && (
                          <span
                            className={cn('text-[10px] font-medium', isActive ? 'text-primary-foreground/80' : 'text-amber-400/80')}
                            title={t('latest.needsPanelBridge')}
                          >
                            bridge
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            {filteredGroups.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">{t('latest.noControlMatches')}</p>
            )}
          </nav>

          {activity.length > 0 && (
            <div className="rounded-md border border-border/60 bg-card">
              <p className="border-b border-border/60 px-3 py-2 text-xs font-semibold text-foreground">{t('latest.recentActions')}</p>
              <ul className="divide-y divide-border/40">
                {activity.map((entry) => (
                  <li key={entry.key} className="flex items-start gap-2 px-3 py-2">
                    {entry.ok
                      ? <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                      : <X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />}
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">{entry.label}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{entry.at}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{activeMeta.label}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{activeMeta.hint}</p>
          </div>

          {activeMeta.needsBridge && !bridgeConnected && (
            <Alert className="border-warning/40 bg-warning/10">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertTitle className="text-warning">{t('latest.panelBridgeOffline')}</AlertTitle>
              <AlertDescription>
                {t('latest.controlsNeedBridgePrefix')} <Link to="/settings?tab=bridge" className="text-primary underline-offset-2 hover:underline">{t('title')}</Link>{t('latest.controlsNeedBridgeSuffix')}
              </AlertDescription>
            </Alert>
          )}

        {activeSection === 'rain' && (
            <TacticalPanel>
              <SectionHeader label={t('labels.rainStorms')} sublabel={t('labels.rcon')} icon={CloudRain} />
              <div className="p-4 space-y-6">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <CloudRain className="w-3.5 h-3.5 text-info" />
                      {t('desc.rain')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-info">{rainIntensity}%</span>
                  </div>
                  <Slider aria-label={t('labels.rainIntensity')} value={[rainIntensity]} onValueChange={([val]) => setRainIntensity(val)} min={1} max={100} step={1} />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => handleAction('Start rain', startRain)} disabled={loading !== null} className="h-9 gap-2 text-xs font-medium">
                      {loading === 'Start rain' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudRain className="w-3.5 h-3.5" />}
                      {t('btn.startRain')}
                    </Button>
                    <Button variant="outline" onClick={() => handleAction('Stop rain', stopRain)} disabled={loading !== null} className="h-9 gap-2 text-xs font-medium">
                      {loading === 'Stop rain' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudOff className="w-3.5 h-3.5" />}
                      {t('btn.stopRain')}
                    </Button>
                  </div>
                </div>

                <div className="space-y-3 pt-4 border-t border-border/40">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <CloudLightning className="w-3.5 h-3.5 text-amber-400" />
                      {t('desc.storm')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-amber-400">{stormDuration}h</span>
                  </div>
                  <Slider aria-label={t('labels.stormDuration')} value={[stormDuration]} onValueChange={([val]) => setStormDuration(val)} min={1} max={24} step={1} />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => handleAction('Start storm', startStorm)} disabled={loading !== null} className="h-9 gap-2 text-xs font-medium">
                      {loading === 'Start storm' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudLightning className="w-3.5 h-3.5" />}
                      {t('btn.startStorm')}
                    </Button>
                    <Button variant="outline" onClick={() => handleAction('Stop weather', stopWeather)} disabled={loading !== null} className="h-9 gap-2 text-xs font-medium">
                      {loading === 'Stop weather' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cloud className="w-3.5 h-3.5" />}
                      {t('btn.clearWeather')}
                    </Button>
                  </div>
                </div>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'severe' && (
            <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
              <SectionHeader
                label={t('labels.severeWeather')}
                sublabel={bridgeConnected ? t('desc.bridgeAdvanced') : t('desc.bridgeOffline')}
                icon={Snowflake}
                tone={bridgeConnected ? 'primary' : 'warning'}
              />
              <div className="p-4 space-y-6">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Snowflake className="w-3.5 h-3.5 text-info" />
                      blizzard
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-info">{blizzardDuration}h</span>
                  </div>
                  <Slider aria-label={t('labels.blizzardDuration')} value={[blizzardDuration]} onValueChange={([val]) => setBlizzardDuration(val)} min={1} max={24} step={1} disabled={!bridgeConnected} />
                  <Button variant="outline" onClick={() => handleBridgeAction('Blizzard', () => panelBridgeApi.triggerBlizzard(blizzardDuration))} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                    {bridgeLoading === 'Blizzard' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Snowflake className="w-3.5 h-3.5" />}
                    trigger blizzard
                  </Button>
                </div>

                <div className="space-y-3 pt-4 border-t border-border/40">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Wind className="w-3.5 h-3.5 text-amber-400" />
                      tropical storm
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-amber-400">{tropicalDuration}h</span>
                  </div>
                  <Slider aria-label={t('labels.tropicalStormDuration')} value={[tropicalDuration]} onValueChange={([val]) => setTropicalDuration(val)} min={1} max={24} step={1} disabled={!bridgeConnected} />
                  <Button variant="outline" onClick={() => handleBridgeAction('Tropical Storm', () => panelBridgeApi.triggerTropicalStorm(tropicalDuration))} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                    {bridgeLoading === 'Tropical Storm' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wind className="w-3.5 h-3.5" />}
                    trigger tropical storm
                  </Button>
                </div>

                <div className="space-y-3 pt-4 border-t border-border/40">
                  <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                    <Snowflake className="w-3.5 h-3.5 text-info" />
                    snow toggle
                  </Label>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => handleBridgeAction('Enable Snow', () => panelBridgeApi.setSnow(true))} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Enable Snow' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Snowflake className="w-3.5 h-3.5" />}
                      enable snow
                    </Button>
                    <Button variant="outline" onClick={() => handleBridgeAction('Disable Snow', () => panelBridgeApi.setSnow(false))} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Disable Snow' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudRain className="w-3.5 h-3.5" />}
                      disable snow
                    </Button>
                  </div>
                  <Button variant="outline" onClick={() => handleBridgeAction('Stop All Weather', () => panelBridgeApi.stopWeather())} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium text-destructive/85 hover:text-destructive hover:border-destructive/40">
                    {bridgeLoading === 'Stop All Weather' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cloud className="w-3.5 h-3.5" />}
                    {t('btn.stopAllWeather')}
                  </Button>
                </div>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'climate' && (
          <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
            <SectionHeader
              label={t('labels.climateTrim')}
              sublabel={bridgeConnected ? t('desc.bridgeAdminOverride') : t('desc.bridgeOffline')}
              icon={Gauge}
              tone={bridgeConnected ? 'primary' : 'warning'}
              action={bridgeConnected ? (
                <Button variant="ghost" size="sm" onClick={() => handleBridgeAction('Reset Climate', async () => { const r = await panelBridgeApi.resetClimateOverrides(); climateDirtyUntilRef.current = 0; return r })} disabled={bridgeLoading !== null} className="h-6 px-2 gap-1 text-xs font-medium">
                  <RotateCcw className="w-3 h-3" />
                  {t('btn.reset')}
                </Button>
              ) : undefined}
            />
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Eye className="w-3.5 h-3.5 text-primary/80" />
                      fog
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{fogIntensity}%</span>
                  </div>
                  <Slider aria-label={t('labels.fogIntensity')} value={[fogIntensity]} onValueChange={([val]) => { markClimateDirty(); setFogIntensity(val) }} min={0} max={100} step={5} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Wind className="w-3.5 h-3.5 text-primary/80" />
                      wind
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{windIntensity}%</span>
                  </div>
                  <Slider aria-label={t('labels.windIntensity')} value={[windIntensity]} onValueChange={([val]) => { markClimateDirty(); setWindIntensity(val) }} min={0} max={100} step={5} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Thermometer className="w-3.5 h-3.5 text-primary/80" />
                      temperature
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{temperature}°C</span>
                  </div>
                  <Slider aria-label={t('labels.temperature')} value={[temperature]} onValueChange={([val]) => { markClimateDirty(); setTemperature(val) }} min={-30} max={45} step={1} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Cloud className="w-3.5 h-3.5 text-primary/80" />
                      clouds
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{cloudIntensity}%</span>
                  </div>
                  <Slider aria-label={t('labels.cloudIntensity')} value={[cloudIntensity]} onValueChange={([val]) => { markClimateDirty(); setCloudIntensity(val) }} min={0} max={100} step={5} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Droplets className="w-3.5 h-3.5 text-primary/80" />
                      humidity
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{humidity}%</span>
                  </div>
                  <Slider aria-label={t('labels.humidity')} value={[humidity]} onValueChange={([val]) => { markClimateDirty(); setHumidity(val) }} min={0} max={100} step={5} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <CloudRain className="w-3.5 h-3.5 text-primary/80" />
                      precipitation
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{precipitationIntensity}%</span>
                  </div>
                  <Slider aria-label={t('labels.precipitationIntensity')} value={[precipitationIntensity]} onValueChange={([val]) => { markClimateDirty(); setPrecipitationIntensity(val) }} min={0} max={100} step={5} disabled={!bridgeConnected} />
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-3 border-t border-border/40">
                <Button
                  onClick={() => handleBridgeAction('Apply All Climate', async () => {
                    await Promise.all([
                      panelBridgeApi.setClimateFloat(5, fogIntensity / 100),
                      panelBridgeApi.setClimateFloat(6, windIntensity / 100),
                      panelBridgeApi.setClimateFloat(4, temperature),
                      panelBridgeApi.setClimateFloat(8, cloudIntensity / 100),
                      panelBridgeApi.setClimateFloat(12, humidity / 100),
                      panelBridgeApi.setClimateFloat(3, precipitationIntensity / 100),
                    ])
                    // Allow the next poll to re-sync from authoritative game state.
                    climateDirtyUntilRef.current = 0
                  })}
                  disabled={bridgeLoading !== null || !bridgeConnected}
                  className="h-9 gap-2 text-xs font-medium"
                >
                  {bridgeLoading === 'Apply All Climate' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Gauge className="w-3.5 h-3.5" />}
                  {t('btn.applyAll')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleBridgeAction('Start Rain', () => panelBridgeApi.startRain(Math.max(0.05, precipitationIntensity / 100)))}
                  disabled={bridgeLoading !== null || !bridgeConnected}
                  title={t('tooltips.startRain')}
                  className="h-9 gap-2 text-xs font-medium"
                >
                  <CloudRain className="w-3.5 h-3.5" /> {t('desc.rain')} · {Math.max(5, precipitationIntensity)}%
                </Button>
                <Button variant="outline" onClick={() => handleBridgeAction('Stop Rain', () => panelBridgeApi.stopRain())} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                  <CloudOff className="w-3.5 h-3.5" /> {t('btn.stopRain')}
                </Button>
              </div>
            </div>
          </TacticalPanel>
        )}

        {activeSection === 'clock' && (
            <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
              <SectionHeader label={t('labels.gameClock')} sublabel={t('latest.clockSublabel')} icon={Calendar} tone={bridgeConnected ? 'primary' : 'warning'} />
              <div className="p-4 space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      {gameHour >= 6 && gameHour < 20 ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5 text-info" />}
                      hour
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{String(gameHour).padStart(2, '0')}:00</span>
                  </div>
                  <Slider aria-label={t('labels.gameHour')} value={[gameHour]} onValueChange={([val]) => setGameHour(val)} min={0} max={23} step={1} disabled={!bridgeConnected} />
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <Button variant={gameHour === 6 ? 'secondary' : 'outline'} size="sm" onClick={() => setGameHour(6)} disabled={!bridgeConnected} className="h-8 gap-1 text-xs font-medium"><Sunrise className="w-3 h-3" /> {t('desc.dawn')}</Button>
                  <Button variant={gameHour === 12 ? 'secondary' : 'outline'} size="sm" onClick={() => setGameHour(12)} disabled={!bridgeConnected} className="h-8 gap-1 text-xs font-medium"><Sun className="w-3 h-3" /> {t('desc.noon')}</Button>
                  <Button variant={gameHour === 18 ? 'secondary' : 'outline'} size="sm" onClick={() => setGameHour(18)} disabled={!bridgeConnected} className="h-8 gap-1 text-xs font-medium"><Sunset className="w-3 h-3" /> {t('desc.dusk')}</Button>
                  <Button variant={gameHour === 0 ? 'secondary' : 'outline'} size="sm" onClick={() => setGameHour(0)} disabled={!bridgeConnected} className="h-8 gap-1 text-xs font-medium"><Moon className="w-3 h-3" /> {t('desc.midnight')}</Button>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <div className="space-y-1">
                    <Label htmlFor="game-day" className="text-xs font-medium text-muted-foreground">{t('day')}</Label>
                    <Input id="game-day" aria-label={t('labels.gameDay')} type="number" min={1} max={31} value={gameDay} disabled={!bridgeConnected} onChange={(e) => {
                      const parsed = parseInt(e.target.value, 10)
                      if (Number.isNaN(parsed)) { setGameDay(1); return }
                      setGameDay(Math.min(31, Math.max(1, parsed)))
                    }} className="h-9 font-mono text-[12px] tabular-nums" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="game-month" className="text-xs font-medium text-muted-foreground">{t('month')}</Label>
                    <Select value={String(gameMonth)} onValueChange={(v) => setGameMonth(parseInt(v))} disabled={!bridgeConnected}>
                      <SelectTrigger id="game-month" aria-label={t('labels.gameMonth')} className="h-9 font-mono text-[12px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">{t('january')}</SelectItem>
                        <SelectItem value="2">{t('february')}</SelectItem>
                        <SelectItem value="3">{t('march')}</SelectItem>
                        <SelectItem value="4">{t('april')}</SelectItem>
                        <SelectItem value="5">{t('may')}</SelectItem>
                        <SelectItem value="6">{t('june')}</SelectItem>
                        <SelectItem value="7">{t('july')}</SelectItem>
                        <SelectItem value="8">{t('august')}</SelectItem>
                        <SelectItem value="9">{t('september')}</SelectItem>
                        <SelectItem value="10">{t('october')}</SelectItem>
                        <SelectItem value="11">{t('november')}</SelectItem>
                        <SelectItem value="12">{t('december')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Button variant="outline" onClick={() => handleBridgeAction('Set Time', () => panelBridgeApi.setGameTime({ hour: gameHour, day: gameDay, month: gameMonth }))} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                  {bridgeLoading === 'Set Time' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
                  apply time & date
                </Button>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'timespeed' && (
            <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
            <SectionHeader label={t('labels.timeSpeed')} sublabel={t('labels.bridgeResets')} icon={Clock} tone={bridgeConnected ? 'primary' : 'warning'} />
              <div className="p-4 flex flex-col gap-4">
                <p className="text-xs text-muted-foreground/75 leading-relaxed">
                  Accelerate the in-game clock. Useful for testing weather, day/night cycles, or fast-forwarding events. Resets to 1× when the server restarts.
                </p>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85">{t('multiplier')}</Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{timeSpeed}x</span>
                  </div>
                  <Slider aria-label={t('labels.timeSpeedLabel')} value={[timeSpeed]} onValueChange={([val]) => setTimeSpeed(val)} min={1} max={100} step={1} />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" onClick={() => setTimeSpeed(1)} variant={timeSpeed === 1 ? 'secondary' : 'outline'} className="h-8 text-xs font-medium tabular-nums">1×</Button>
                  <Button size="sm" onClick={() => setTimeSpeed(5)} variant={timeSpeed === 5 ? 'secondary' : 'outline'} className="h-8 text-xs font-medium tabular-nums">5×</Button>
                  <Button size="sm" onClick={() => setTimeSpeed(10)} variant={timeSpeed === 10 ? 'secondary' : 'outline'} className="h-8 text-xs font-medium tabular-nums">10×</Button>
                  <Button size="sm" onClick={() => setTimeSpeed(24)} variant={timeSpeed === 24 ? 'secondary' : 'outline'} className="h-8 text-xs font-medium tabular-nums">24×</Button>
                </div>
                <Button variant="outline" onClick={() => handleAction('Set time speed', setGameTimeSpeed)} disabled={loading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                  {loading === 'Set time speed' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
                  {t('btn.applySpeed')}
                </Button>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'utilities' && (
          <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
            <SectionHeader
              label={t('labels.utilities')}
              sublabel={t('labels.powerWaterGrid')}
              icon={Zap}
              tone={bridgeConnected ? 'primary' : 'warning'}
              action={bridgeConnected ? (
                  <Button variant="ghost" size="sm" onClick={() => checkBridgeStatus()} className="h-6 px-2 gap-1 text-xs font-medium">
                  <RefreshCw className="w-3 h-3" /> {t('btn.refresh')}
                </Button>
              ) : undefined}
            />
            <div className="p-4 space-y-4">
              <div className="flex items-start gap-2 rounded border border-amber-400/25 bg-amber-400/[0.05] px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-400/85">
                <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
                <span>{t('b42MultiplayerSandboxChangesDoNotPropagateToConnectedClientsYet')}</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-md border border-border/50 bg-muted/15 p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-foreground/85">
                      <Zap className="w-3.5 h-3.5 text-amber-400" /> {t('desc.power')}
                    </span>
                    <span className={cn(
                      'flex items-center gap-1.5 text-xs font-medium',
                      utilitiesStatus === null ? 'text-muted-foreground' : utilitiesStatus.powerOn ? 'text-emerald-400' : 'text-destructive'
                    )}>
                      <span className={cn(
                        'w-1.5 h-1.5 rounded-full',
                        utilitiesStatus === null ? 'bg-muted-foreground/40'
                          : utilitiesStatus.powerOn ? 'bg-emerald-400 animate-pulse' : 'bg-destructive'
                      )} />
                      {utilitiesStatus === null ? '…' : utilitiesStatus.powerOn ? t('ui.online') : t('ui.offline')}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                      <Button variant="outline" size="sm" disabled={!bridgeConnected || loading !== null} onClick={() => handleUtilities('Restore Power', true, true, false)} className="h-8 text-xs font-medium text-emerald-400/90 hover:text-emerald-400 hover:border-emerald-400/40">
                      {t('btn.restore')}
                    </Button>
                      <Button variant="outline" size="sm" disabled={!bridgeConnected || loading !== null} onClick={() => handleUtilities('Shut Off Power', false, true, false)} className="h-8 text-xs font-medium text-destructive/90 hover:text-destructive hover:border-destructive/40">
                      {t('btn.shutOff')}
                    </Button>
                  </div>
                </div>

                <div className="rounded-md border border-border/50 bg-muted/15 p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-foreground/85">
                      <Droplets className="w-3.5 h-3.5 text-info" /> {t('desc.water')}
                    </span>
                    <span className={cn(
                      'flex items-center gap-1.5 text-xs font-medium',
                      utilitiesStatus === null ? 'text-muted-foreground' : utilitiesStatus.waterOn ? 'text-emerald-400' : 'text-destructive'
                    )}>
                      <span className={cn(
                        'w-1.5 h-1.5 rounded-full',
                        utilitiesStatus === null ? 'bg-muted-foreground/40'
                          : utilitiesStatus.waterOn ? 'bg-emerald-400 animate-pulse' : 'bg-destructive'
                      )} />
                      {utilitiesStatus === null ? '…' : utilitiesStatus.waterOn ? t('ui.online') : t('ui.offline')}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                      <Button variant="outline" size="sm" disabled={!bridgeConnected || loading !== null} onClick={() => handleUtilities('Restore Water', true, false, true)} className="h-8 text-xs font-medium text-emerald-400/90 hover:text-emerald-400 hover:border-emerald-400/40">
                      {t('btn.restore')}
                    </Button>
                      <Button variant="outline" size="sm" disabled={!bridgeConnected || loading !== null} onClick={() => handleUtilities('Shut Off Water', false, false, true)} className="h-8 text-xs font-medium text-destructive/90 hover:text-destructive hover:border-destructive/40">
                      {t('btn.shutOff')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </TacticalPanel>
        )}

        {activeSection === 'quickSounds' && (
            <TacticalPanel tone="warning">
              <SectionHeader label={t('labels.quickSounds')} sublabel={t('labels.rconAttracts')} icon={Volume2} tone="warning" />
              <div className="p-4 space-y-3">
                <p className="font-mono text-[11px] text-muted-foreground/75 leading-relaxed">
                  {t('desc.quickSoundsDesc')}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => handleAction('Helicopter', triggerChopper)} disabled={loading !== null || players.length === 0} title={players.length === 0 ? t('ui.noPlayersOnline') : undefined} className="h-9 gap-2 text-xs font-medium">
                    {loading === 'Helicopter' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crosshair className="w-3.5 h-3.5" />}
                    helicopter
                  </Button>
                  <Button variant="outline" onClick={() => handleAction('Gunshot', triggerGunshot)} disabled={loading !== null || players.length === 0} title={players.length === 0 ? t('ui.noPlayersOnline') : undefined} className="h-9 gap-2 text-xs font-medium">
                    {loading === 'Gunshot' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5" />}
                    gunshot
                  </Button>
                  <Button variant="outline" onClick={() => handleAction('Lightning', () => triggerLightning(pickStrikeTarget()))} disabled={loading !== null || players.length === 0} title={players.length === 0 ? t('ui.noPlayersOnline') : t('latest.lightningTarget')} className="h-9 gap-2 text-xs font-medium text-amber-400/90 hover:text-amber-400 hover:border-amber-400/40">
                    {loading === 'Lightning' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                    lightning
                  </Button>
                  <Button variant="outline" onClick={() => handleAction('Thunder', () => triggerThunder(pickStrikeTarget()))} disabled={loading !== null || players.length === 0} title={players.length === 0 ? t('ui.noPlayersOnline') : t('latest.thunderTarget')} className="h-9 gap-2 text-xs font-medium">
                    {loading === 'Thunder' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudLightning className="w-3.5 h-3.5" />}
                    thunder
                  </Button>
                  <Button variant="outline" onClick={() => handleAction('Alarm', triggerAlarm)} disabled={loading !== null} title={t('tooltips.requiresAdmin')} className="h-9 gap-2 text-xs font-medium">
                    {loading === 'Alarm' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
                    {t('btn.buildingAlarm')}
                  </Button>
                </div>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'targetedSounds' && (
            <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
              <SectionHeader
                label={t('labels.targetedSounds')}
                sublabel={bridgeConnected ? t('desc.bridgeCustomNoise') : t('desc.bridgeOffline')}
                icon={Megaphone}
                tone={bridgeConnected ? 'primary' : 'warning'}
              />
              <div className="p-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                        <Target className="w-3.5 h-3.5 text-primary/80" /> {t('desc.radius')}
                      </Label>
                      <span className="font-mono text-[11px] tabular-nums text-primary">{soundRadius}m</span>
                    </div>
                    <Slider aria-label={t('labels.soundRadius')} value={[soundRadius]} onValueChange={([val]) => setSoundRadius(val)} min={10} max={300} step={10} disabled={!bridgeConnected} />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                        <Volume2 className="w-3.5 h-3.5 text-primary/80" /> {t('desc.volume')}
                      </Label>
                      <span className="font-mono text-[11px] tabular-nums text-primary">{soundVolume}</span>
                    </div>
                    <Slider aria-label={t('labels.soundVolume')} value={[soundVolume]} onValueChange={([val]) => setSoundVolume(val)} min={10} max={300} step={10} disabled={!bridgeConnected} />
                  </div>
                </div>

                <div className="space-y-2 pt-3 border-t border-border/40">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <User className="w-3 h-3" /> {t('desc.atTargetLocation')}
                    </span>
                    <span className="text-xs font-medium text-muted-foreground/70">
                      {targetAll || !selectedPlayer ? t('desc.pickSpecificPlayer') : selectedPlayer}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => handleBridgeAction('Gunshot Sound', () => panelBridgeApi.triggerGunshotBridge({ username: selectedPlayer || undefined }))} disabled={bridgeLoading !== null || !bridgeConnected || targetAll || !selectedPlayer} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Gunshot Sound' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5" />}
                      gunshot
                    </Button>
                    <Button variant="outline" onClick={() => handleBridgeAction('Alarm Sound', () => panelBridgeApi.triggerAlarmBridge({ username: selectedPlayer || undefined }))} disabled={bridgeLoading !== null || !bridgeConnected || targetAll || !selectedPlayer} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Alarm Sound' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
                      alarm
                    </Button>
                    <Button variant="outline" onClick={() => handleBridgeAction('Custom Noise', () => panelBridgeApi.createNoise({ username: selectedPlayer, radius: soundRadius, volume: soundVolume }))} disabled={bridgeLoading !== null || !bridgeConnected || targetAll || !selectedPlayer} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Custom Noise' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Megaphone className="w-3.5 h-3.5" />}
                      noise
                    </Button>
                  </div>
                </div>

                <div className="space-y-2 pt-3 border-t border-border/40">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <MapPin className="w-3 h-3" /> {t('desc.atWorldCoords')}
                    </span>
                    <span className="text-xs font-medium text-muted-foreground/70">
                      kentucky · 0 – 15000
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="sound-world-x" className="text-xs font-medium text-muted-foreground">{t('axis.x')}</Label>
                      <Input id="sound-world-x" aria-label={t('labels.soundX')} type="number" placeholder={t('placeholders.defaultX')} value={soundX} onChange={(e) => setSoundX(e.target.value)} disabled={!bridgeConnected} className="h-9 font-mono text-[12px] tabular-nums" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="sound-world-y" className="text-xs font-medium text-muted-foreground">{t('axis.y')}</Label>
                      <Input id="sound-world-y" aria-label={t('labels.soundY')} type="number" placeholder={t('placeholders.defaultY')} value={soundY} onChange={(e) => setSoundY(e.target.value)} disabled={!bridgeConnected} className="h-9 font-mono text-[12px] tabular-nums" />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => handleBridgeAction('Gunshot at Coords', () => panelBridgeApi.triggerGunshotBridge({ x: soundCoordX as number, y: soundCoordY as number }))} disabled={bridgeLoading !== null || !bridgeConnected || !hasValidSoundCoords} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Gunshot at Coords' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5" />}
                      gunshot
                    </Button>
                    <Button variant="outline" onClick={() => handleBridgeAction('Alarm at Coords', () => panelBridgeApi.triggerAlarmBridge({ x: soundCoordX as number, y: soundCoordY as number }))} disabled={bridgeLoading !== null || !bridgeConnected || !hasValidSoundCoords} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Alarm at Coords' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
                      alarm
                    </Button>
                    <Button variant="outline" onClick={() => handleBridgeAction('Noise at Coords', () => panelBridgeApi.createNoise({ x: soundCoordX as number, y: soundCoordY as number, radius: soundRadius, volume: soundVolume }))} disabled={bridgeLoading !== null || !bridgeConnected || !hasValidSoundCoords} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Noise at Coords' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Megaphone className="w-3.5 h-3.5" />}
                      noise
                    </Button>
                  </div>
                </div>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'horde' && (
            <TacticalPanel tone={bridgeConnected ? 'destructive' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
              <SectionHeader label={t('labels.spawnHorde')} sublabel={bridgeConnected ? t('desc.bridgeLoadedCells') : t('desc.bridgeOffline')} icon={Skull} tone={bridgeConnected ? 'destructive' : 'warning'} />
              <div className="p-4 space-y-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Skull className="w-3.5 h-3.5 text-destructive" /> {t('desc.count')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-destructive">{hordeCount}</span>
                  </div>
                  <Slider aria-label={t('labels.hordeSize')} value={[hordeCount]} onValueChange={([val]) => setHordeCount(val)} min={10} max={500} step={10} />
                </div>
                <Button variant="outline" onClick={() => handleAction('Create horde', () => createHorde(hordeCount, pickStrikeTarget()))} disabled={loading !== null || !bridgeConnected || players.length === 0 || (!targetAll && !selectedPlayer)} title={players.length === 0 ? t('ui.noPlayersOnline') : !bridgeConnected ? t('ui.bridgeOffline') : undefined} className="h-9 gap-2 text-xs font-medium">
                  {loading === 'Create horde' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Skull className="w-3.5 h-3.5" />}
                  {t('latest.spawnNear', { target: targetAll ? t('ui.random') : selectedPlayer || t('ui.target') })}
                </Button>
                <Button variant="outline" onClick={() => handleAction('Create horde (behind)', () => createHorde2(hordeCount, pickStrikeTarget()))} disabled={loading !== null || !bridgeConnected || players.length === 0 || (!targetAll && !selectedPlayer)} title={players.length === 0 ? t('ui.noPlayersOnline') : !bridgeConnected ? t('ui.bridgeOffline') : undefined} className="h-9 gap-2 text-xs font-medium">
                  {loading === 'Create horde (behind)' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Skull className="w-3.5 h-3.5" />}
                  {t('latest.spawnBehind', { target: targetAll ? t('ui.random') : selectedPlayer || t('ui.target') })}
                </Button>
                <Button variant="outline" onClick={() => handleAction('Remove all zombies', removeZombies)} disabled={loading !== null || !bridgeConnected} title={!bridgeConnected ? t('ui.bridgeOffline') : undefined} className="h-9 gap-2 text-xs font-medium text-destructive/95 hover:text-destructive hover:border-destructive/50 hover:bg-destructive/10">
                  {loading === 'Remove all zombies' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                  {t('btn.clearLoadedZombies')}
                </Button>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'vehicles' && (
            <TacticalPanel tone="info">
            <SectionHeader label={t('labels.spawnVehicle')} sublabel={t('labels.rconNearPlayer')} icon={Car} tone="info" />
              <div className="p-4 space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vehicle-type-select" className="text-xs font-medium text-muted-foreground">{t('vehicle')}</Label>
                  <Select value={selectedVehicle} onValueChange={setSelectedVehicle}>
                    <SelectTrigger id="vehicle-type-select" aria-label={t('labels.vehicleType')} className="h-9 font-mono text-[12px]">
                      <SelectValue placeholder={t('placeholders.selectVehicle')} />
                    </SelectTrigger>
                    <SelectContent>
                      {vehicles.map((vehicle) => (
                        <SelectItem key={vehicle.id} value={vehicle.id}>{t(vehicle.nameKey)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">{t('spawnFor')}</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {players.length === 0 ? (
                      <p className="font-mono text-[11px] text-muted-foreground/70 italic">{t('ui.noPlayersOnline')}</p>
                    ) : players.map((player) => (
                      <Button key={player.name} variant="outline" size="sm" onClick={() => handleAction('Spawn vehicle', () => spawnVehicle(selectedVehicle, player.name))} disabled={loading !== null || !selectedVehicle} title={!selectedVehicle ? t('ui.selectVehicleFirst') : undefined} className="h-8 gap-1.5 text-xs font-medium">
                        <Car className="w-3 h-3" /> {player.name}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'teleport' && (
          <TacticalPanel tone="info">
            <SectionHeader label={t('labels.teleport')} sublabel={t('labels.rconMovePlayers')} icon={MapPin} tone="info" />
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <div className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                  <Users className="w-3 h-3 text-info" /> {t('desc.playerToPlayer')}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="teleport-player-select" className="text-xs font-medium text-muted-foreground">{t('playerToMove')}</Label>
                  <Select value={selectedPlayer} onValueChange={setSelectedPlayer}>
                    <SelectTrigger id="teleport-player-select" aria-label={t('labels.playerToMove')} className="h-9 font-mono text-[12px]">
                      <SelectValue placeholder={t('placeholders.selectPlayer')} />
                    </SelectTrigger>
                    <SelectContent>
                      {players.length === 0 ? (
                        <div className="px-2 py-1.5 font-mono text-[11px] text-muted-foreground">{t('ui.noPlayersOnline')}</div>
                      ) : players.map((player) => (
                        <SelectItem key={player.name} value={player.name}>{player.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label id="teleport-target-player-label" className="text-xs font-medium text-muted-foreground">{t('moveTo')}</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {players.filter(p => p.name !== selectedPlayer).map((player) => (
                      <Button key={player.name} variant="outline" size="sm" onClick={() => handleAction('Teleport', () => teleportPlayerToPlayer(selectedPlayer, player.name))} disabled={loading !== null || !selectedPlayer} className="h-8 text-xs font-medium">
                        {player.name}
                      </Button>
                    ))}
                    {players.length <= 1 && (
                      <p className="font-mono text-[11px] text-muted-foreground/70 italic">{t('need2PlayersOnline')}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                    <Navigation className="w-3 h-3 text-info" /> {t('desc.toCoordinates')}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                  <Label htmlFor="teleport-x" className="text-xs font-medium text-muted-foreground">{t('axis.x')}</Label>
                    <Input id="teleport-x" aria-label={t('labels.teleportX')} type="number" placeholder="10000" value={teleportX} onChange={(e) => setTeleportX(e.target.value)} className="h-9 font-mono text-[12px] tabular-nums" />
                  </div>
                  <div className="space-y-1">
                  <Label htmlFor="teleport-y" className="text-xs font-medium text-muted-foreground">{t('axis.y')}</Label>
                    <Input id="teleport-y" aria-label={t('labels.teleportY')} type="number" placeholder="11000" value={teleportY} onChange={(e) => setTeleportY(e.target.value)} className="h-9 font-mono text-[12px] tabular-nums" />
                  </div>
                  <div className="space-y-1">
                  <Label htmlFor="teleport-z" className="text-xs font-medium text-muted-foreground">{t('axis.z')}</Label>
                    <Input id="teleport-z" aria-label={t('labels.teleportZ')} type="number" placeholder="0" value={teleportZ} onChange={(e) => setTeleportZ(e.target.value)} className="h-9 font-mono text-[12px] tabular-nums" />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => handleAction('Teleport self', () => teleportToCoords(teleportCoordX as number, teleportCoordY as number, teleportCoordZ as number))} disabled={loading !== null || !hasValidTeleportCoords} title={t('tooltips.teleportSelf')} className="h-9 gap-2 text-xs font-medium">
                    {loading === 'Teleport self' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
                    teleport self
                  </Button>
                  <Button variant="outline" onClick={() => handleAction('Teleport player', () => teleportToCoords(teleportCoordX as number, teleportCoordY as number, teleportCoordZ as number, getTargetPlayer()))} disabled={loading !== null || !hasValidTeleportCoords || targetAll || !selectedPlayer} title={t('tooltips.teleportPlayer')} className="h-9 gap-2 text-xs font-medium">
                    {loading === 'Teleport player' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Navigation className="w-3.5 h-3.5" />}
                    teleport {selectedPlayer || 'target'}
                  </Button>
                </div>
                <p className="font-mono text-[11px] text-muted-foreground/65 leading-relaxed">
                  muldraugh 10500,9700 · west point 11800,6900 · riverside 6500,5300
                </p>
              </div>
            </div>
          </TacticalPanel>
        )}

        {activeSection === 'broadcast' && (
          <TacticalPanel tone="warning">
            <SectionHeader label={t('labels.broadcast')} sublabel={t('labels.rconServerWide')} icon={Megaphone} tone="warning" />
            <div className="p-4 space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="announcement-message" className="text-xs font-medium text-muted-foreground">{t('message')}</Label>
                  <span className={cn(
                    'font-mono text-[10px] tabular-nums',
                    announcement.length > 450 ? 'text-amber-400' : 'text-muted-foreground/65'
                  )}>
                    {announcement.length}/500
                  </span>
                </div>
                <Input id="announcement-message" aria-label={t('labels.announcementMessage')} placeholder={t('placeholders.announcement')} value={announcement} onChange={(e) => setAnnouncement(e.target.value)} maxLength={500} className="h-9" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setAnnouncement(t('latest.announcementWarningText'))} className="h-8 gap-1.5 text-xs font-medium">
                  <AlertTriangle className="h-3 w-3 text-amber-400" /> {t('btn.eventWarning')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAnnouncement(t('latest.announcementLootText'))} className="h-8 gap-1.5 text-xs font-medium">
                  <Bell className="h-3 w-3 text-primary" /> {t('btn.lootNotice')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAnnouncement(t('latest.announcementHordeText'))} className="h-8 gap-1.5 text-xs font-medium">
                  <Navigation className="h-3 w-3 text-destructive" /> {t('btn.hordeAlert')}
                </Button>
              </div>
              <Button variant="outline" onClick={() => handleAction('Send announcement', sendAnnouncement)} disabled={loading !== null || !announcement.trim()} className="h-9 gap-2 text-xs font-medium">
                {loading === 'Send announcement' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Megaphone className="w-3.5 h-3.5" />}
                {t('btn.broadcastMessage')}
              </Button>
            </div>
          </TacticalPanel>
        )}

        {activeSection === 'bridgeOps' && (
          <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-95' : ''}>
            <SectionHeader
              label={t('labels.bridgeTools')}
              sublabel={bridgeConnected ? `${t('bridge')} · ${t('ui.operationCount', { count: Object.keys(translatedTemplates).length })}` : `${t('desc.bridgeOffline')} · ${t('ui.privileged')}`}
              icon={Zap}
              tone={bridgeConnected ? 'primary' : 'warning'}
              action={
                <>
                  {bridgeActiveGroup && (
                    <span className="font-mono text-[10px] tracking-[0.14em] text-primary/75">{bridgeActiveGroup.label}</span>
                  )}
                  <span className="text-xs font-medium text-muted-foreground/70">
                    {bridgeLastRunAt ? t('latest.lastRun', { time: bridgeLastRunAt }) : t('latest.neverRun')}
                  </span>
                </>
              }
            />
            <div className="p-4 space-y-4">
                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.35fr)]">
                      <div className="space-y-4">
                        <div className="rounded-lg border border-border/70 bg-muted/25 p-4">
                          <div className="space-y-2">
                            <Label htmlFor="bridge-operation-select">{t('operation')}</Label>
                            <p className="text-xs leading-5 text-muted-foreground">
                              Choose an operation, fill in the required fields, and run it.
                            </p>
                          </div>
                      <Select
                        value={bridgeOperation}
                        onValueChange={selectBridgeOperation}
                      >
                        <SelectTrigger id="bridge-operation-select" aria-label={t('labels.selectOperation')} disabled={bridgeLoading !== null} className="mt-3">
                          <SelectValue placeholder={t('labels.selectOperation')} />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(translatedTemplates).map(([action, meta]) => (
                            <SelectItem key={action} value={action}>{meta.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                        <div className="mt-3 rounded-md border border-border/60 bg-background/60 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-foreground">{translatedTemplates[bridgeOperation]?.label}</p>
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                {translatedTemplates[bridgeOperation]?.description}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border border-border/70 bg-muted/20 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-foreground">{t('operationGroups')}</p>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                              Browse by category: territory, vehicles, events, and moderation.
                            </p>
                          </div>
                        </div>
                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          {translatedGroups.map((group) => {
                            const active = group.id === bridgeActiveGroup?.id
                            return (
                              <div
                                key={group.id}
                                className={cn(
                                  'rounded-md border p-3 transition-colors',
                                  active
                                    ? 'border-primary/40 bg-primary/10 text-foreground'
                                    : 'border-border/60 bg-background/40 text-muted-foreground'
                                )}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <p className={cn('text-sm font-medium', active ? 'text-foreground' : 'text-foreground/88')}>
                                    {group.label}
                                  </p>
                                  <Badge variant={active ? 'default' : 'outline'}>{group.operations.length}</Badge>
                                </div>
                                <p className="mt-2 text-xs leading-5">{group.description}</p>
                              </div>
                            )
                          })}
                        </div>
                        {bridgeActiveGroup && (
                          <div className="mt-4 rounded-md border border-border/60 bg-background/50 p-3">
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <p className="text-xs font-medium text-foreground">{t('latest.quickPicks', { group: bridgeActiveGroup.label })}</p>
                              <Badge variant="outline">{bridgeActiveGroup.operations.length} {t('latest.options')}</Badge>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {bridgeActiveGroup.operations.map((operationKey) => {
                                const operationMeta = translatedTemplates[operationKey]
                                if (!operationMeta) return null

                                const isActive = operationKey === bridgeOperation
                                return (
                                  <Button
                                    key={operationKey}
                                    type="button"
                                    variant={isActive ? 'secondary' : 'outline'}
                                    size="sm"
                                    onClick={() => selectBridgeOperation(operationKey)}
                                    disabled={bridgeLoading !== null}
                                    className="h-9"
                                  >
                                    {operationMeta.label}
                                  </Button>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-lg border border-border/70 bg-card/60 p-4">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <Label>{t('operationInputs')}</Label>
                            <p id="bridge-args-help" className="mt-1 text-xs leading-5 text-muted-foreground">
                              {t('latest.operationInputsHelp')}
                            </p>
                          </div>
                          <Badge variant={bridgeFormError ? 'destructive' : 'outline'}>
                            {bridgeFormError ? t('latest.needsAttention') : currentBridgeFields.length === 0 ? t('latest.noInputsRequired') : t('latest.ready')}
                          </Badge>
                        </div>

                        {currentRequiredFieldCount > 0 && (
                          <div className="mt-3 rounded-md border border-border/60 bg-background/40 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-xs text-muted-foreground">{t('requiredFieldsCompleted')}</p>
                              <p className="text-xs font-medium text-foreground">
                                {currentCompletedRequiredFieldCount}/{currentRequiredFieldCount}
                              </p>
                            </div>
                            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full w-full rounded-full bg-primary transition-transform duration-200 ease-out"
                                style={{
                                  transform: `translateX(-${100 - Math.min(
                                    100,
                                    Math.round((currentCompletedRequiredFieldCount / currentRequiredFieldCount) * 100)
                                  )}%)`,
                                }}
                              />
                            </div>
                          </div>
                        )}

                        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {currentBridgeFields.length === 0 && (
                            <div className="sm:col-span-2 rounded-md border border-border/60 bg-muted/20 p-3 text-sm text-foreground/85">
                              {t('latest.operationNoInputs')}
                            </div>
                          )}

                          {currentBridgeFields.map((field) => {
                            const value = getBridgeFieldValue(field.key)
                            const fieldId = `bridge-field-${field.key}`

                            if (field.type === 'boolean') {
                              return (
                                <div key={field.key} className="sm:col-span-2 rounded-md border border-border/60 bg-muted/20 p-3">
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="space-y-1">
                                      <Label htmlFor={fieldId}>{field.label}</Label>
                                      {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
                                    </div>
                                    <Switch
                                      id={fieldId}
                                      checked={value === 'true'}
                                      onCheckedChange={(checked) => setBridgeFieldValue(field.key, checked ? 'true' : 'false')}
                                    />
                                  </div>
                                </div>
                              )
                            }

                            if (field.type === 'select') {
                              return (
                                <div key={field.key} className="space-y-1.5">
                                  <Label htmlFor={fieldId}>{field.label}{field.required ? ' *' : ''}</Label>
                                  <Select value={value || field.defaultValue || ''} onValueChange={(next) => setBridgeFieldValue(field.key, next)}>
                                    <SelectTrigger id={fieldId}>
                                      <SelectValue placeholder={field.placeholder || t('ui.selectValue')} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {(field.options ?? []).map((option) => (
                                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              )
                            }

                            if (field.type === 'combo') {
                              const options = getBridgeComboOptions(field.key)
                              const hasOptions = options.length > 0
                              const showManualFallback = !hasOptions && !bridgeOptionsLoading

                              return (
                                <div key={field.key} className="space-y-1.5">
                                  <Label htmlFor={fieldId}>{field.label}{field.required ? ' *' : ''}</Label>
                                  <Select
                                    value={hasOptions ? value : ''}
                                    onValueChange={(next) => setBridgeFieldValue(field.key, next)}
                                    disabled={bridgeOptionsLoading || !hasOptions}
                                  >
                                    <SelectTrigger id={fieldId}>
                                      <SelectValue
                                        placeholder={
                                          bridgeOptionsLoading
                                            ? t('latest.loadingServerOptions')
                                              : hasOptions
                                              ? (field.placeholder || t('latest.selectValue'))
                                              : t('latest.noServerOptions')
                                        }
                                      />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {hasOptions ? (
                                        options.map((option) => (
                                          <SelectItem key={option.value} value={option.value} title={option.label}>
                                            <span className="block truncate" dir="auto" title={option.label}>{option.label}</span>
                                          </SelectItem>
                                        ))
                                      ) : (
                                        <div className="px-2 py-2 text-xs text-muted-foreground">
                                          {bridgeOptionsLoading ? t('latest.loadingOptionsFromServer') : t('latest.noOptionsLoaded')}
                                        </div>
                                      )}
                                    </SelectContent>
                                  </Select>
                                  {showManualFallback && (
                                    <Input
                                      value={value}
                                      onChange={(e) => setBridgeFieldValue(field.key, e.target.value)}
                                      placeholder={field.placeholder || t('ui.typeValueManually')}
                                      aria-label={`${field.label} (manual entry)`}
                                    />
                                  )}
                                  <p className="text-xs text-muted-foreground">
                                    {hasOptions
                                      ? t('latest.loadedFromServer')
                                      : bridgeOptionsLoading
                                        ? t('latest.waitingForServerData')
                                        : t('latest.serverListUnavailable')}
                                  </p>
                                </div>
                              )
                            }

                            if (field.type === 'textarea') {
                              return (
                                <div key={field.key} className="space-y-1.5 sm:col-span-2">
                                  <Label htmlFor={fieldId}>{field.label}{field.required ? ' *' : ''}</Label>
                                  <Textarea
                                    id={fieldId}
                                    value={value}
                                    onChange={(e) => setBridgeFieldValue(field.key, e.target.value)}
                                    placeholder={field.placeholder}
                                    className="min-h-[96px]"
                                  />
                                </div>
                              )
                            }

                            return (
                              <div key={field.key} className="space-y-1.5">
                                <Label htmlFor={fieldId}>{field.label}{field.required ? ' *' : ''}</Label>
                                <Input
                                  id={fieldId}
                                  type={field.type === 'number' ? 'number' : 'text'}
                                  value={value}
                                  onChange={(e) => setBridgeFieldValue(field.key, e.target.value)}
                                  placeholder={field.placeholder}
                                  min={field.min}
                                  max={field.max}
                                  step={field.step}
                                  maxLength={field.maxLength}
                                />
                                {(field.help || field.maxLength) && (
                                  <p className="text-xs text-muted-foreground">
                                    {field.help ? `${field.help}${field.maxLength ? ' ' : ''}` : ''}
                                    {field.maxLength ? `${value.length}/${field.maxLength}` : ''}
                                  </p>
                                )}
                              </div>
                            )
                          })}
                        </div>

                        {currentBridgeHasComboFields && (
                          <div className="mt-3 rounded-md border border-border/60 bg-background/40 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs text-muted-foreground" aria-live="polite">
                                {bridgeOptionsLoading
                                  ? t('latest.refreshingBridgeLists')
                                  : bridgeOptionsError
                                    ? bridgeOptionsError
                                    : bridgeOptionsLastUpdated
                                      ? t('latest.bridgeListsUpdated', { time: bridgeOptionsLastUpdated })
                                      : t('latest.bridgeListsNotLoaded')}
                              </p>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  if (bridgeConnected && !bridgeOptionsLoading) {
                                    setBridgeOptionsLastUpdated(null)
                                    setBridgeOptionsError(null)
                                    setBridgeOptionsRefreshTick((prev) => prev + 1)
                                  }
                                }}
                                disabled={!bridgeConnected || bridgeOptionsLoading}
                                className="h-10 gap-1 sm:h-8"
                              >
                                <RefreshCw className={cn('h-3.5 w-3.5', bridgeOptionsLoading && 'animate-spin')} />
                                {t('latest.refreshLists')}
                              </Button>
                            </div>
                          </div>
                        )}

                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs text-muted-foreground">
                            {t('latest.fieldsPrefilled')}
                          </p>
                          <span className="text-xs text-muted-foreground">
                            {bridgeLastRunAt ? t('latest.lastRun', { time: bridgeLastRunAt }) : t('latest.neverRun')}
                          </span>
                        </div>
                      {bridgeConnectionSummary && (
                        <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
                          {t('latest.bridgeFileLink', { summary: bridgeConnectionSummary })}
                        </p>
                      )}
                      {bridgeFormError && (
                        <p id="bridge-args-error" className="mt-2 text-xs text-destructive">{bridgeFormError}</p>
                      )}
                      </div>
                    </div>
                  </div>

                  {!bridgeConnected && (
                    <Alert className="border-warning/40 bg-warning/10">
                      <AlertTriangle className="h-4 w-4 text-warning" />
                      <AlertTitle className="text-warning">{t('bridgeConnectionRequired')}</AlertTitle>
                      <AlertDescription>
                        {t('ui.bridgeRequiredDesc')}
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      onClick={runBridgeOperation}
                      disabled={bridgeLoading !== null || !bridgeConnected || !!bridgeFormError}
                      className="h-11 gap-2"
                    >
                      {bridgeLoading === bridgeOperation ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                      {t('latest.runOperation')}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={resetBridgeFormValues}
                      disabled={bridgeLoading !== null || currentBridgeFields.length === 0}
                      className="h-11"
                    >
                        {t('latest.resetForm')}
                    </Button>
                    {bridgeResultData && (
                      <Button
                        variant="outline"
                        onClick={() => setBridgeResultData(null)}
                        disabled={bridgeLoading !== null}
                        className="h-11"
                      >
                        {t('latest.clearResult')}
                      </Button>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    {bridgeRunDisabledReason || t('latest.ready')}
                  </p>

                  {/* Structured Result Display */}
                  {bridgeResultData && (
                    <BridgeResultDisplay
                      result={bridgeResultData}
                      loading={bridgeLoading}
                      onInlineAction={runInlineAction}
                      players={players}
                      t={t}
                      translatedTemplates={translatedTemplates}
                    />
                  )}
            </div>
          </TacticalPanel>
        )}
        </div>
      </div>
    </div>
  )
}
