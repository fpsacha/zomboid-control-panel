import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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
  SunMedium,
  Moon,
  Eye,
  Gauge,
  Telescope,
  Contrast,
  Lightbulb,
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
  Search,
  Waves,
  Plane
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
import { rconApi, serverApi, playersApi, panelBridgeApi, ApiError } from '@/lib/api'
import { getBridgeVerifiedState } from '@/lib/bridgeVerify'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { DisabledReason } from '@/components/DisabledReason'
import { HelpTip } from '@/components/HelpTip'
import { cn } from '@/lib/utils'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useConfirm } from '@/contexts/ConfirmContext'
import { useSocket } from '@/contexts/SocketContext'

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
  isBridgeOffline = false,
}: {
  label: string
  sublabel?: string
  icon?: React.ComponentType<{ className?: string }>
  action?: React.ReactNode
  tone?: PanelTone
  isBridgeOffline?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-border/60 px-4 py-3 select-none sm:flex-row sm:items-center sm:justify-between sm:gap-3">
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
      {action && <div className="flex items-center gap-1.5 sm:shrink-0">{action}</div>}
    </div>
  )
}

// A single control that both shows and flips a known on/off game state --
// replaces the enable/disable- or start/stop-shaped BUTTON PAIRS this page
// used to have one per concept (operator complaint 2026-08-31: "if i enable
// snow... the same button should show disable, not have 2 buttons ... valid
// for all the buttons that there are 2 of them like that"). `state: null`
// is a REQUIRED third value, not a loading nicety -- it means the real state
// has not landed yet (or its fetch failed) and the switch renders disabled
// with neutral styling rather than guessing a position. A Switch's checked
// position IS the claim "this is definitely on/off right now"; showing one
// confidently from a `null`/undefined value would be exactly the "faked
// toggle" the request explicitly ruled out for state that can't be known.
function StateToggle({
  icon: Icon,
  label,
  state,
  onLabel,
  offLabel,
  pendingLabel,
  onToggle,
  disabled,
  ariaLabel,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  state: boolean | null
  onLabel: string
  offLabel: string
  pendingLabel: string
  onToggle: (next: boolean) => void
  disabled: boolean
  ariaLabel: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/15 p-3">
      <span className="flex items-center gap-1.5 text-xs font-medium text-foreground/85">
        <Icon className="w-3.5 h-3.5" /> {label}
      </span>
      <div className="flex items-center gap-2">
        <span className={cn(
          'flex items-center gap-1.5 text-xs font-medium',
          state ? 'text-emerald-400' : 'text-muted-foreground'
        )}>
          <span className={cn(
            'w-1.5 h-1.5 rounded-full',
            state === true ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground/40'
          )} />
          {state === null ? pendingLabel : state ? onLabel : offLabel}
        </span>
        <Switch
          checked={state === true}
          onCheckedChange={(checked) => onToggle(checked)}
          disabled={disabled || state === null}
          aria-label={ariaLabel}
        />
      </div>
    </div>
  )
}

// elecShutModifier/waterShutModifier are the day-thresholds the game's own
// power formula (ISButtonPrompt.lua:421, replicated in PanelBridge.lua's
// getUtilitiesStatus) compares worldAgeDays against to produce powerOn/
// waterOn. 2147483647 is that Lua's own documented "never shuts off"
// sentinel (see its restoreUtilities comment); shown as-is otherwise rather
// than reinterpreted, so this never re-derives -- and risks disagreeing
// with -- the verdict the Lua already computed.
function formatShutoffModifier(modifier: number, t: TFunction) {
  return modifier >= 2147483647 ? t('utilities.modifierNever') : String(modifier)
}

function getEventSuccessCopy(action: string, t: TFunction) {
  const copy = (key: string) => ({ title: t(`successCopy.${key}.title`), description: t(`successCopy.${key}.description`) })
  switch (action) {
    case 'Start rain':
    case 'Start Rain':
      return copy('rainStarted')
    case 'Stop rain':
    case 'Stop Rain':
      return copy('rainStopped')
    case 'Start storm':
    case 'Trigger storm':
      return copy('stormTriggered')
    case 'Tropical Storm':
    case 'Trigger tropical storm':
      return copy('tropicalStormTriggered')
    case 'Blizzard':
    case 'Trigger blizzard':
      return copy('blizzardTriggered')
    case 'Stop weather':
    case 'Stop All Weather':
      return copy('weatherCleared')
    case 'Generate Weather Front':
      return copy('weatherFrontGenerated')
    case 'Enable Snow':
      return copy('snowEnabled')
    case 'Disable Snow':
      return copy('snowDisabled')
    case 'Reset Climate':
      return copy('climateReset')
    case 'Set Fog':
      return copy('fogUpdated')
    case 'Set Wind':
      return copy('windUpdated')
    case 'Set Temperature':
      return copy('temperatureUpdated')
    case 'Set Clouds':
      return copy('cloudsUpdated')
    case 'Set Humidity':
      return copy('humidityUpdated')
    case 'Set Precipitation':
      return copy('precipitationUpdated')
    case 'Set Time':
      return copy('timeUpdated')
    case 'Restore Utilities':
      return copy('utilitiesRestored')
    case 'Shut Off Utilities':
      return copy('utilitiesShutDown')
    case 'Restore Power':
      return copy('powerRestored')
    case 'Restore Water':
      return copy('waterRestored')
    case 'Shut Off Power':
      return copy('powerShutDown')
    case 'Shut Off Water':
      return copy('waterShutDown')
    case 'Helicopter':
      return copy('helicopterTriggered')
    case 'Gunshot':
    case 'Gunshot Sound':
    case 'Gunshot at Coords':
      return copy('gunshotTriggered')
    case 'Alarm':
    case 'Alarm Sound':
    case 'Alarm at Coords':
      return copy('alarmTriggered')
    case 'Custom Noise':
    case 'Noise at Coords':
      return copy('noiseCreated')
    case 'Lightning':
      return copy('lightningTriggered')
    case 'Thunder':
      return copy('thunderTriggered')
    case 'Create horde':
      return copy('hordeSpawned')
    case 'Create horde (behind)':
      return copy('rearHordeSpawned')
    case 'Remove all zombies':
      return copy('zombiesCleared')
    case 'Clear zombies near player':
      return copy('zombiesClearedNear')
    case 'Set time speed':
      return copy('timeSpeedUpdated')
    case 'Teleport':
    case 'Teleport self':
    case 'Teleport player':
      return copy('teleportComplete')
    case 'Spawn vehicle':
      return copy('vehicleSpawned')
    case 'Send announcement':
      return copy('announcementSent')
    case 'Apply All Climate':
      return copy('climateApplied')
    case 'Apply All Visual':
      return copy('visualApplied')
    case 'Helicopter Event':
      return copy('helicopterEventTriggered')
    case 'Stop Helicopter Event':
      return copy('helicopterEventStopped')
    default:
      return { title: t('successCopy.actionCompleteDefault.title'), description: t('successCopy.actionCompleteDefault.description', { action }) }
  }
}

// Vehicle presets for GM
function getVehiclePresets(t: TFunction) {
  return [
    { id: 'Base.VanAmbulance', name: t('vehicles.names.VanAmbulance') },
    { id: 'Base.PickUpVanLightsPolice', name: t('vehicles.names.PickUpVanLightsPolice') },
    { id: 'Base.CarLightsPolice', name: t('vehicles.names.CarLightsPolice') },
    { id: 'Base.PickUpTruckMccoy', name: t('vehicles.names.PickUpTruckMccoy') },
    { id: 'Base.Van', name: t('vehicles.names.Van') },
    { id: 'Base.ModernCar', name: t('vehicles.names.ModernCar') },
    { id: 'Base.SportsCar', name: t('vehicles.names.SportsCar') },
    { id: 'Base.SUV', name: t('vehicles.names.SUV') },
    { id: 'Base.StepVan', name: t('vehicles.names.StepVan') },
    { id: 'Base.Taxi', name: t('vehicles.names.Taxi') },
  ]
}

// PanelBridge operation catalog. `args` are literal JSON payload examples with
// placeholder values (e.g. "PlayerName") — API templates, not prose, so they
// stay in English. `label`/`description` are real UI text and get translated.
export function getBridgeOperationTemplates(t: TFunction): Record<string, { label: string; description: string; args: string }> {
  return {
    getSafehouses: { label: t('operations.getSafehouses.label'), description: t('operations.getSafehouses.description'), args: '{}' },
    safehouseAddPlayer: { label: t('operations.safehouseAddPlayer.label'), description: t('operations.safehouseAddPlayer.description'), args: '{\n  "safehouseRef": "SafehouseIdOrTitle",\n  "username": "PlayerName"\n}' },
    safehouseRemovePlayer: { label: t('operations.safehouseRemovePlayer.label'), description: t('operations.safehouseRemovePlayer.description'), args: '{\n  "safehouseRef": "SafehouseIdOrTitle",\n  "username": "PlayerName"\n}' },
    safehouseSetOwner: { label: t('operations.safehouseSetOwner.label'), description: t('operations.safehouseSetOwner.description'), args: '{\n  "safehouseRef": "SafehouseIdOrTitle",\n  "owner": "PlayerName"\n}' },
    safehouseSetRespawn: { label: t('operations.safehouseSetRespawn.label'), description: t('operations.safehouseSetRespawn.description'), args: '{\n  "safehouseRef": "SafehouseIdOrTitle",\n  "username": "PlayerName",\n  "enabled": true\n}' },
    getFactions: { label: t('operations.getFactions.label'), description: t('operations.getFactions.description'), args: '{}' },
    factionAddPlayer: { label: t('operations.factionAddPlayer.label'), description: t('operations.factionAddPlayer.description'), args: '{\n  "factionName": "FactionName",\n  "username": "PlayerName"\n}' },
    factionRemovePlayer: { label: t('operations.factionRemovePlayer.label'), description: t('operations.factionRemovePlayer.description'), args: '{\n  "factionName": "FactionName",\n  "username": "PlayerName"\n}' },
    factionSetTag: { label: t('operations.factionSetTag.label'), description: t('operations.factionSetTag.description'), args: '{\n  "factionName": "FactionName",\n  "tag": "TAG"\n}' },
    getVehiclesDetailed: { label: t('operations.getVehiclesDetailed.label'), description: t('operations.getVehiclesDetailed.description'), args: '{}' },
    triggerSwarmEvent: { label: t('operations.triggerSwarmEvent.label'), description: t('operations.triggerSwarmEvent.description'), args: '{\n  "count": 25,\n  "x1": 10500,\n  "y1": 9800,\n  "x2": 10600,\n  "y2": 9900\n}' },
    runEventSequence: { label: t('operations.runEventSequence.label'), description: t('operations.runEventSequence.description'), args: '{\n  "steps": [\n    { "kind": "chat", "message": "Event incoming", "channel": "general" },\n    { "kind": "weather", "weatherType": "storm", "duration": 2 }\n  ]\n}' },
    getInfrastructureSnapshot: { label: t('operations.getInfrastructureSnapshot.label'), description: t('operations.getInfrastructureSnapshot.description'), args: '{\n  "x": 10500,\n  "y": 9800,\n  "z": 0\n}' },

    moderationKickUser: { label: t('operations.moderationKickUser.label'), description: t('operations.moderationKickUser.description'), args: '{\n  "username": "PlayerName",\n  "reason": "Rule violation"\n}' },
    moderationBanUser: { label: t('operations.moderationBanUser.label'), description: t('operations.moderationBanUser.description'), args: '{\n  "username": "PlayerName",\n  "reason": "Rule violation",\n  "ban": true\n}' },
    moderationBanIP: { label: t('operations.moderationBanIP.label'), description: t('operations.moderationBanIP.description'), args: '{\n  "ip": "127.0.0.1",\n  "reason": "Abuse",\n  "ban": true\n}' },
    moderationBanSteamID: { label: t('operations.moderationBanSteamID.label'), description: t('operations.moderationBanSteamID.description'), args: '{\n  "steamId": "76561198000000000",\n  "reason": "Abuse",\n  "ban": true\n}' },
  }
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

export function getBridgeOperationForms(t: TFunction): Record<string, BridgeOperationForm> {
  const f = t as (key: string) => string
  return {
    getSafehouses: { fields: [] },
    safehouseAddPlayer: {
      fields: [
        { key: 'safehouseRef', label: f('operationForms.safehouseRef'), type: 'combo', required: true, placeholder: f('operationForms.selectSafehouse') },
        { key: 'username', label: f('operationForms.playerUsername'), type: 'combo', required: true, placeholder: f('operationForms.selectPlayer') },
      ],
    },
    safehouseRemovePlayer: {
      fields: [
        { key: 'safehouseRef', label: f('operationForms.safehouseRef'), type: 'combo', required: true, placeholder: f('operationForms.selectSafehouse') },
        { key: 'username', label: f('operationForms.playerUsername'), type: 'combo', required: true, placeholder: f('operationForms.selectPlayer') },
      ],
    },
    safehouseSetOwner: {
      fields: [
        { key: 'safehouseRef', label: f('operationForms.safehouseRef'), type: 'combo', required: true, placeholder: f('operationForms.selectSafehouse') },
        { key: 'owner', label: f('operationForms.newOwner'), type: 'combo', required: true, placeholder: f('operationForms.selectPlayer') },
      ],
    },
    safehouseSetRespawn: {
      fields: [
        { key: 'safehouseRef', label: f('operationForms.safehouseRef'), type: 'combo', required: true, placeholder: f('operationForms.selectSafehouse') },
        { key: 'username', label: f('operationForms.playerUsername'), type: 'combo', required: true, placeholder: f('operationForms.selectPlayer') },
        { key: 'enabled', label: f('operationForms.allowRespawn'), type: 'boolean', defaultValue: 'true' },
      ],
    },
    getFactions: { fields: [] },
    factionAddPlayer: {
      fields: [
        { key: 'factionName', label: f('operationForms.factionName'), type: 'combo', required: true, placeholder: f('operationForms.selectFaction') },
        { key: 'username', label: f('operationForms.playerUsername'), type: 'combo', required: true, placeholder: f('operationForms.selectPlayer') },
      ],
    },
    factionRemovePlayer: {
      fields: [
        { key: 'factionName', label: f('operationForms.factionName'), type: 'combo', required: true, placeholder: f('operationForms.selectFaction') },
        { key: 'username', label: f('operationForms.playerUsername'), type: 'combo', required: true, placeholder: f('operationForms.selectPlayer') },
      ],
    },
    factionSetTag: {
      fields: [
        { key: 'factionName', label: f('operationForms.factionName'), type: 'combo', required: true, placeholder: f('operationForms.selectFaction') },
        {
          key: 'tag',
          label: f('operationForms.tag'),
          type: 'text',
          required: true,
          placeholder: f('operationForms.tagPlaceholder'),
          maxLength: 12,
          pattern: /^[A-Za-z0-9_-]{1,12}$/,
          patternHint: f('operationForms.tagPatternHint'),
        },
      ],
    },
    getVehiclesDetailed: { fields: [] },
    triggerSwarmEvent: {
      fields: [
        { key: 'count', label: f('operationForms.zombieCount'), type: 'number', required: true, defaultValue: '25', min: 1, max: 500 },
        { key: 'x1', label: f('operationForms.x1'), type: 'number', required: true, defaultValue: '10500' },
        { key: 'y1', label: f('operationForms.y1'), type: 'number', required: true, defaultValue: '9800' },
        { key: 'x2', label: f('operationForms.x2'), type: 'number', required: true, defaultValue: '10600' },
        { key: 'y2', label: f('operationForms.y2'), type: 'number', required: true, defaultValue: '9900' },
      ],
    },
    runEventSequence: {
      fields: [
        {
          key: 'preset',
          label: f('operationForms.sequencePreset'),
          type: 'select',
          required: true,
          defaultValue: 'storm_alert',
          options: [
            { value: 'storm_alert', label: f('operationForms.presetStormAlert') },
            { value: 'panic_noise', label: f('operationForms.presetPanicNoise') },
            { value: 'utilities_shutdown', label: f('operationForms.presetUtilitiesShutdown') },
          ],
        },
        { key: 'message', label: f('operationForms.broadcastMessage'), type: 'text', defaultValue: 'Event incoming', maxLength: 240 },
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
        { key: 'x', label: f('operationForms.xOptional'), type: 'number', placeholder: '10500' },
        { key: 'y', label: f('operationForms.yOptional'), type: 'number', placeholder: '9800' },
        { key: 'z', label: f('operationForms.zOptional'), type: 'number', defaultValue: '0', placeholder: '0' },
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
        { key: 'username', label: f('operationForms.username'), type: 'combo', required: true, placeholder: f('operationForms.selectPlayer') },
        { key: 'reason', label: f('operationForms.reason'), type: 'combo', defaultValue: 'Rule violation' },
      ],
    },
    moderationBanUser: {
      fields: [
        { key: 'username', label: f('operationForms.username'), type: 'combo', required: true, placeholder: f('operationForms.selectPlayer') },
        { key: 'reason', label: f('operationForms.reason'), type: 'combo', defaultValue: 'Rule violation' },
        { key: 'ban', label: f('operationForms.banUser'), type: 'boolean', defaultValue: 'true' },
      ],
    },
    moderationBanIP: {
      fields: [
        {
          key: 'ip',
          label: f('operationForms.ipAddress'),
          type: 'text',
          required: true,
          placeholder: '127.0.0.1',
          pattern: /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/,
          patternHint: f('operationForms.ipPatternHint'),
        },
        { key: 'reason', label: f('operationForms.reason'), type: 'combo', defaultValue: 'Abuse' },
        { key: 'ban', label: f('operationForms.banIp'), type: 'boolean', defaultValue: 'true' },
      ],
    },
    moderationBanSteamID: {
      fields: [
        {
          key: 'steamId',
          label: f('operationForms.steamId'),
          type: 'text',
          required: true,
          placeholder: '76561198000000000',
          maxLength: 17,
          pattern: /^\d{17}$/,
          patternHint: f('operationForms.steamIdPatternHint'),
        },
        { key: 'reason', label: f('operationForms.reason'), type: 'combo', defaultValue: 'Abuse' },
        { key: 'ban', label: f('operationForms.banSteamId'), type: 'boolean', defaultValue: 'true' },
      ],
    },
  }
}

export function getBridgeOperationGroups(t: TFunction) {
  return [
    {
      id: 'territory',
      label: t('operationGroups.territory.label'),
      description: t('operationGroups.territory.description'),
      // createFaction and removeFaction are deliberately absent: Faction.createFaction
      // and faction:removeFaction do not exist anywhere in the real B42 jar (confirmed
      // by a full 23,740-class scan) -- offering them was a control that always failed
      // with no path to ever working, dressed up as a normal quick-pick button. The
      // remaining faction operations below call real methods and work.
      operations: ['getSafehouses', 'safehouseAddPlayer', 'safehouseRemovePlayer', 'safehouseSetOwner', 'safehouseSetRespawn', 'getFactions', 'factionAddPlayer', 'factionRemovePlayer', 'factionSetTag'],
    },
    {
      id: 'vehicles',
      label: t('operationGroups.vehicles.label'),
      description: t('operationGroups.vehicles.description'),
      operations: ['getVehiclesDetailed'],
    },
    {
      id: 'events',
      label: t('operationGroups.events.label'),
      description: t('operationGroups.events.description'),
      operations: ['triggerSwarmEvent', 'runEventSequence', 'getInfrastructureSnapshot'],
    },
    {
      id: 'moderation',
      label: t('operationGroups.moderation.label'),
      description: t('operationGroups.moderation.description'),
      operations: ['moderationKickUser', 'moderationBanUser', 'moderationBanIP', 'moderationBanSteamID'],
    },
  ] as const
}

const formatPanelTimestamp = (date: Date, locale?: string): string => {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(date)
  } catch {
    return date.toLocaleString(locale)
  }
}

// ============================================
// STRUCTURED RESULT DISPLAY
// ============================================

interface BridgeResultDisplayProps {
  result: BridgeResultData
  loading: string | null
  onInlineAction: (action: string, args: Record<string, unknown>, label: string) => Promise<void>
  players: Player[]
}

// runEventSequence's own response shape (PanelBridge.lua handlers.runEventSequence),
// present on BOTH the success branch (failedCount: 0) and the failure branch
// (failedCount > 0) -- Lua returns the same `data` table either way so a
// caller can always tell 9-of-10 from 0-of-10 without parsing `results`
// itself. See server/routes/panelBridge.js's POST /command catch handler for
// why this can currently be absent on a failed sequence (a separate,
// server-side gap -- reported, not fixed here, since it's outside this file):
// when present, render the three real states below; when absent (e.g. an
// infra-level failure, or the pre-Kevin's-fix bridge mod), fall through to
// the generic failure card unchanged.
interface EventSequenceStepResult {
  index: number
  kind: string
  success: boolean
  data?: unknown
  error?: string
}
interface EventSequenceResultData {
  message: string
  executed: number
  maxSteps: number
  failedCount: number
  results: EventSequenceStepResult[]
}
function isEventSequenceResultData(data: unknown): data is EventSequenceResultData {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return typeof d.executed === 'number' && typeof d.failedCount === 'number' && Array.isArray(d.results)
}

function EventSequenceResult({ data, timestamp }: { data: EventSequenceResultData; timestamp: string }) {
  const { t } = useTranslation('events')
  const { executed, failedCount, results } = data
  const allSucceeded = failedCount === 0
  const allFailed = executed > 0 && failedCount === executed
  const tone = allSucceeded ? 'success' : allFailed ? 'destructive' : 'warning'
  const toneClasses = {
    success: { border: 'border-success/40', bg: 'bg-success/5', text: 'text-success' },
    warning: { border: 'border-warning/40', bg: 'bg-warning/5', text: 'text-warning' },
    destructive: { border: 'border-destructive/40', bg: 'bg-destructive/5', text: 'text-destructive' },
  }[tone]
  const Icon = allSucceeded ? Check : allFailed ? X : AlertTriangle
  const title = allSucceeded
    ? t('resultDisplay.sequenceAllSucceededTitle')
    : allFailed
      ? t('resultDisplay.sequenceAllFailedTitle')
      : t('resultDisplay.sequencePartialTitle', { failed: failedCount, executed })
  const failedSteps = results.filter((r) => !r.success)

  return (
    <div className={cn('rounded-lg border p-4 space-y-3', toneClasses.border, toneClasses.bg)}>
      <div className="flex items-center justify-between">
        <div className={cn('flex items-center gap-2 text-sm font-medium', toneClasses.text)}>
          <Icon className="h-4 w-4" />
          {title}
        </div>
        <span className="text-xs text-muted-foreground">{timestamp}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('resultDisplay.sequenceExecutedCount', { executed })}
      </p>
      {failedSteps.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('resultDisplay.sequenceFailedStepsTitle')}
          </p>
          <ul className="space-y-1">
            {failedSteps.map((step) => (
              <li key={step.index} className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-1.5 text-xs">
                <X className="h-3.5 w-3.5 shrink-0 mt-0.5 text-destructive" />
                <span className="min-w-0">
                  <span className="font-mono text-muted-foreground">{t('resultDisplay.sequenceStepIndex', { index: step.index })}</span>{' '}
                  <span className="font-medium">{step.kind}</span>
                  {step.error && <span className="text-muted-foreground"> — {step.error}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function BridgeResultDisplay({ result, loading, onInlineAction, players }: BridgeResultDisplayProps) {
  const { t } = useTranslation('events')
  const bridgeOperationTemplates = useMemo(() => getBridgeOperationTemplates(t), [t])
  const [showRaw, setShowRaw] = useState(false)
  const [safehouseAddSelection, setSafehouseAddSelection] = useState<Record<string, string>>({})
  const { operation, success, data, error, timestamp } = result
  const isLoading = loading !== null

  // Checked before the generic !success gate below: a partial failure is
  // real information (9 of 10 steps genuinely ran), not just "not success" --
  // showing the plain red card for it is the exact bug this exists to fix
  // (green-on-total-failure is worse, but red-on-partial was never right
  // either, and per-step results being reachable only via raw JSON is what
  // let both hide). Runs for the success branch too (failedCount: 0 reads as
  // "all succeeded" here rather than falling through to whatever a generic
  // success renderer would otherwise show for this operation.
  if (operation === 'runEventSequence' && isEventSequenceResultData(data)) {
    return <EventSequenceResult data={data} timestamp={timestamp} />
  }

  if (!success) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <X className="h-4 w-4" />
          {t('resultDisplay.operationFailed')}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{error || t('resultDisplay.unknownError')}</p>
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
        <ResultCard title={t('resultDisplay.noVehiclesTitle')} icon={<Car className="h-4 w-4" />} timestamp={timestamp}>
          <p className="text-sm text-muted-foreground">{t('resultDisplay.noVehiclesDesc')}</p>
        </ResultCard>
      )
    }
    return (
      <div className="rounded-lg border border-border/70 bg-muted/15 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Car className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{t('resultDisplay.vehiclesLoaded', { count: vehicles.length })}</span>
          </div>
          <span className="text-xs text-muted-foreground">{timestamp}</span>
        </div>
        <div className="overflow-x-auto -mx-1 pb-1 [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]">
          <table className="w-full min-w-max text-sm">
            <thead>
              <tr className="border-b border-border/60 text-start">
                <th className="pb-2 pe-3 text-xs font-medium text-muted-foreground">{t('resultDisplay.idHeader')}</th>
                <th className="pb-2 pe-3 text-xs font-medium text-muted-foreground">{t('resultDisplay.typeHeader')}</th>
                <th className="pb-2 pe-3 text-xs font-medium text-muted-foreground">{t('resultDisplay.locationHeader')}</th>
                <th className="pb-2 pe-3 text-xs font-medium text-muted-foreground">{t('resultDisplay.batteryHeader')}</th>
                <th className="pb-2 pe-3 text-xs font-medium text-muted-foreground">{t('resultDisplay.statusHeader')}</th>
                <th className="pb-2 text-xs font-medium text-muted-foreground">{t('resultDisplay.actionsHeader')}</th>
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
                    <td className="py-2.5 pe-3 font-mono text-xs text-foreground/80">{vid}</td>
                    <td className="py-2.5 pe-3 text-xs">{script || '—'}</td>
                    <td className="py-2.5 pe-3 font-mono text-xs text-foreground/70">{vx}, {vy}</td>
                    <td className="py-2.5 pe-3">
                      <span className={cn('text-xs font-medium', battery > 50 ? 'text-success' : battery > 20 ? 'text-warning' : 'text-destructive')}>
                        {battery}%
                      </span>
                    </td>
                    <td className="py-2.5 pe-3">
                      <div className="flex flex-wrap gap-1">
                        {alarmed && <Badge variant="outline" className="h-5 text-[10px] px-1.5 text-warning border-warning/30">{t('resultDisplay.alarmBadge')}</Badge>}
                        {sirening && <Badge variant="outline" className="h-5 text-[10px] px-1.5 text-info border-info/30">{t('resultDisplay.sirenBadge')}</Badge>}
                        <Badge variant="outline" className={cn('h-5 text-[10px] px-1.5', trunkLocked ? 'text-foreground/60' : 'text-success border-success/30')}>
                          {trunkLocked ? t('resultDisplay.lockedBadge') : t('resultDisplay.openBadge')}
                        </Badge>
                      </div>
                    </td>
                    <td className="py-2.5">
                      <div className="flex flex-wrap gap-1">
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" disabled={isLoading}
                          onClick={() => onInlineAction('vehicleRepair', { vehicleId: vid }, t('resultDisplay.vehicleRepairedLabel', { id: vid }))}>
                          <Wrench className="h-3 w-3" /> {t('resultDisplay.repairButton')}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" disabled={isLoading}
                          onClick={() => onInlineAction('vehicleSetAlarm', { vehicleId: vid, enabled: !alarmed }, alarmed ? t('resultDisplay.alarmDisabledLabel', { id: vid }) : t('resultDisplay.alarmEnabledLabel', { id: vid }))}>
                          {alarmed ? t('resultDisplay.alarmOffButton') : t('resultDisplay.alarmOnButton')}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" disabled={isLoading}
                          onClick={() => onInlineAction('vehicleSetSiren', { vehicleId: vid, enabled: !sirening }, sirening ? t('resultDisplay.sirenDisabledLabel', { id: vid }) : t('resultDisplay.sirenEnabledLabel', { id: vid }))}>
                          {sirening ? t('resultDisplay.sirenOffButton') : t('resultDisplay.sirenOnButton')}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" disabled={isLoading}
                          onClick={() => onInlineAction('vehicleSetTrunkLocked', { vehicleId: vid, locked: !trunkLocked }, trunkLocked ? t('resultDisplay.trunkUnlockedLabel', { id: vid }) : t('resultDisplay.trunkLockedLabel', { id: vid }))}>
                          {trunkLocked ? <><Unlock className="h-3 w-3" /> {t('resultDisplay.unlockButton')}</> : <><Lock className="h-3 w-3" /> {t('resultDisplay.lockButton')}</>}
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
        <ResultCard title={t('resultDisplay.noSafehousesTitle')} icon={<ShieldCheck className="h-4 w-4" />} timestamp={timestamp}>
          <p className="text-sm text-muted-foreground">{t('resultDisplay.noSafehousesDesc')}</p>
        </ResultCard>
      )
    }
    return (
      <div className="rounded-lg border border-border/70 bg-muted/15 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{t('resultDisplay.safehousesCount', { count: safehouses.length })}</span>
          </div>
          <span className="text-xs text-muted-foreground">{timestamp}</span>
        </div>
        <div className="space-y-2">
          {(safehouses as Array<Record<string, unknown>>).map((sh, i) => {
            const title = String(sh.title || sh.id || t('resultDisplay.safehouseFallback', { n: i + 1 }))
            const owner = String(sh.owner || '—')
            const members = Array.isArray(sh.players) ? sh.players : []
            const ref = String(sh.id ?? sh.title ?? '')
            return (
              <div key={ref || i} className="rounded-md border border-border/50 bg-background/40 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{t('resultDisplay.ownerPrefix', { owner })} · {t('resultDisplay.membersCount', { count: members.length })}</p>
                    {members.length > 0 && (
                      <p className="text-xs text-muted-foreground/70 mt-0.5 truncate">{t('resultDisplay.membersListPrefix', { list: members.map(String).join(', ') })}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {players.length > 0 && (
                      <>
                        <select
                          aria-label={t('resultDisplay.addPlayerSelectLabel', { title })}
                          className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                          value={safehouseAddSelection[ref] ?? ''}
                          disabled={isLoading}
                          onChange={(e) => {
                            const value = e.target.value
                            setSafehouseAddSelection((prev) => ({ ...prev, [ref]: value }))
                          }}
                        >
                          <option value="">{t('resultDisplay.addPlayerSelectPlaceholder')}</option>
                          {players.map((p) => (
                            <option key={p.name} value={p.name}>{p.name}</option>
                          ))}
                        </select>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={isLoading || !safehouseAddSelection[ref]}
                          onClick={() => {
                            const username = safehouseAddSelection[ref]
                            if (!username) return
                            onInlineAction('safehouseAddPlayer', { safehouseRef: ref, username }, t('resultDisplay.addedPlayerLabel', { username, title }))
                            setSafehouseAddSelection((prev) => ({ ...prev, [ref]: '' }))
                          }}>
                          {t('resultDisplay.addPlayerButton')}
                        </Button>
                      </>
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
        <ResultCard title={t('resultDisplay.noFactionsTitle')} icon={<Users className="h-4 w-4" />} timestamp={timestamp}>
          <p className="text-sm text-muted-foreground">{t('resultDisplay.noFactionsDesc')}</p>
        </ResultCard>
      )
    }
    return (
      <div className="rounded-lg border border-border/70 bg-muted/15 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{t('resultDisplay.factionsCount', { count: factions.length })}</span>
          </div>
          <span className="text-xs text-muted-foreground">{timestamp}</span>
        </div>
        <div className="space-y-2">
          {(factions as Array<Record<string, unknown>>).map((f, i) => {
            const name = String(f.name || t('resultDisplay.factionFallback', { n: i + 1 }))
            const owner = String(f.owner || '—')
            const tag = String(f.tag || '')
            const members = Array.isArray(f.players) ? f.players : []
            return (
              <div key={name} className="rounded-md border border-border/50 bg-background/40 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{name}</p>
                      {tag && <Badge variant="outline" className="h-5 text-[10px] px-1.5">{tag}</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{t('resultDisplay.ownerPrefix', { owner })} · {t('resultDisplay.membersCount', { count: members.length })}</p>
                    {members.length > 0 && (
                      <p className="text-xs text-muted-foreground/70 mt-0.5 truncate">{t('resultDisplay.membersListPrefix', { list: members.map(String).join(', ') })}</p>
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
    if (!d) return <ResultCard title={t('resultDisplay.noDataTitle')} icon={<Info className="h-4 w-4" />} timestamp={timestamp}><p className="text-sm text-muted-foreground">{t('resultDisplay.emptyResponse')}</p></ResultCard>
    return (
      <ResultCard title={t('resultDisplay.infrastructureSnapshotTitle')} icon={<Gauge className="h-4 w-4" />} timestamp={timestamp}>
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
          {bridgeOperationTemplates[operation]?.label || operation}
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
        {showRaw ? t('resultDisplay.hideDetails') : t('resultDisplay.showDetails')}
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
  | 'visual'
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
  label: string
  hint: string
  keywords: string
  icon: React.ComponentType<{ className?: string }>
  needsBridge: boolean
}

// Sections whose commands act on a chosen player rather than the whole world.
const TARGETED_SECTIONS: EventSectionKey[] = ['quickSounds', 'targetedSounds', 'horde', 'teleport']

// getClimateFloats() reports the real, server-authoritative min/max for each
// ClimateFloat (PanelBridge.lua handlers.getClimateFloats -> cf:getMin()/cf:getMax()).
// Binding the sliders to a hardcoded 0-100 (or -30..45 for temperature) instead of this
// data lets an operator either request a value the game will never honour, or hides
// legitimate values the real range allows. `scale` converts the raw float range into
// the same units the slider/state already use (the five percent-style floats are
// stored as value*100; temperature is stored unscaled).
interface ClimateFloatRange {
  min: number
  max: number
}

function climateSliderBounds(
  range: ClimateFloatRange | undefined,
  fallbackMin: number,
  fallbackMax: number,
  scale: number,
): { min: number; max: number } {
  if (!range) return { min: fallbackMin, max: fallbackMax }
  return { min: Math.round(range.min * scale), max: Math.round(range.max * scale) }
}

interface ActivityEntry {
  key: number
  label: string
  ok: boolean
  at: string
}

export default function Events() {
  const { t, i18n } = useTranslation('events')
  const vehicles = useMemo(() => getVehiclePresets(t), [t])
  const bridgeOperationTemplates = useMemo(() => getBridgeOperationTemplates(t), [t])
  const bridgeOperationForms = useMemo(() => getBridgeOperationForms(t), [t])
  const bridgeOperationGroups = useMemo(() => getBridgeOperationGroups(t), [t])
  const EVENT_SECTION_GROUPS = useMemo(() => ([
    {
      group: t('groups.weather'),
      items: [
        { id: 'rain' as const, label: t('sections.rain.label'), hint: t('sections.rain.hint'), keywords: t('sections.rain.keywords'), icon: CloudRain, needsBridge: false },
        { id: 'severe' as const, label: t('sections.severe.label'), hint: t('sections.severe.hint'), keywords: t('sections.severe.keywords'), icon: Snowflake, needsBridge: true },
        { id: 'climate' as const, label: t('sections.climate.label'), hint: t('sections.climate.hint'), keywords: t('sections.climate.keywords'), icon: Gauge, needsBridge: true },
        { id: 'visual' as const, label: t('sections.visual.label'), hint: t('sections.visual.hint'), keywords: t('sections.visual.keywords'), icon: Telescope, needsBridge: true },
      ],
    },
    {
      group: t('groups.world'),
      items: [
        { id: 'clock' as const, label: t('sections.clock.label'), hint: t('sections.clock.hint'), keywords: t('sections.clock.keywords'), icon: Calendar, needsBridge: true },
        { id: 'timespeed' as const, label: t('sections.timespeed.label'), hint: t('sections.timespeed.hint'), keywords: t('sections.timespeed.keywords'), icon: Clock, needsBridge: true },
        { id: 'utilities' as const, label: t('sections.utilities.label'), hint: t('sections.utilities.hint'), keywords: t('sections.utilities.keywords'), icon: Zap, needsBridge: true },
      ],
    },
    {
      group: t('groups.sounds'),
      items: [
        { id: 'quickSounds' as const, label: t('sections.quickSounds.label'), hint: t('sections.quickSounds.hint'), keywords: t('sections.quickSounds.keywords'), icon: Volume2, needsBridge: false },
        { id: 'targetedSounds' as const, label: t('sections.targetedSounds.label'), hint: t('sections.targetedSounds.hint'), keywords: t('sections.targetedSounds.keywords'), icon: Megaphone, needsBridge: true },
      ],
    },
    {
      group: t('groups.players'),
      items: [
        { id: 'horde' as const, label: t('sections.horde.label'), hint: t('sections.horde.hint'), keywords: t('sections.horde.keywords'), icon: Skull, needsBridge: true },
        { id: 'vehicles' as const, label: t('sections.vehicles.label'), hint: t('sections.vehicles.hint'), keywords: t('sections.vehicles.keywords'), icon: Car, needsBridge: false },
        { id: 'teleport' as const, label: t('sections.teleport.label'), hint: t('sections.teleport.hint'), keywords: t('sections.teleport.keywords'), icon: MapPin, needsBridge: false },
        { id: 'broadcast' as const, label: t('sections.broadcast.label'), hint: t('sections.broadcast.hint'), keywords: t('sections.broadcast.keywords'), icon: Bell, needsBridge: false },
      ],
    },
    {
      group: t('groups.advanced'),
      items: [
        { id: 'bridgeOps' as const, label: t('sections.bridgeOps.label'), hint: t('sections.bridgeOps.hint'), keywords: t('sections.bridgeOps.keywords'), icon: Crosshair, needsBridge: true },
      ],
    },
  ]), [t])
  const EVENT_SECTION_INDEX = useMemo(() => Object.fromEntries(
    EVENT_SECTION_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item]))
  ) as unknown as Record<EventSectionKey, EventSectionMeta>, [EVENT_SECTION_GROUPS])
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
  const [weatherFrontStrength, setWeatherFrontStrength] = useState(50)
  const [weatherFrontType, setWeatherFrontType] = useState('0')
  const [clearZombiesRadius, setClearZombiesRadius] = useState(50)

  // Climate controls
  const [fogIntensity, setFogIntensity] = useState(0)
  const [windIntensity, setWindIntensity] = useState(0)
  const [temperature, setTemperature] = useState(20)
  const [cloudIntensity, setCloudIntensity] = useState(0)
  const [humidity, setHumidity] = useState(50)
  const [precipitationIntensity, setPrecipitationIntensity] = useState(0)
  // Real per-float min/max from getClimateFloats, keyed by ClimateFloat id. Populated
  // once the bridge reports them; sliders fall back to the old hardcoded range until then.
  const [climateRanges, setClimateRanges] = useState<Record<number, ClimateFloatRange>>({})

  // Visual controls (hunt-wave12-2026-08-30: setViewDistance/setDayLight/
  // setNightStrength/setDesaturation/setAmbient each have a dead dedicated
  // route -- applied the same way climate above is, through
  // setClimateFloat with these floats' ids (0/2/9/10/11, see
  // PanelBridge.lua's handlers.getClimateFloats). Read-back verified before
  // building this: getClimateFloats already reports all five, so these
  // sliders show real state, not a seeded guess.
  const [viewDistance, setViewDistance] = useState(0)
  const [dayLight, setDayLight] = useState(0)
  const [nightStrength, setNightStrength] = useState(0)
  const [desaturation, setDesaturation] = useState(0)
  const [ambient, setAmbient] = useState(0)

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
      Object.entries(bridgeOperationForms).map(([operation, form]) => {
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
    elecShutModifier: number
    waterShutModifier: number
    currentWorldDay: number
    nightsSurvived: number
  } | null>(null)

  // Live weather state -- fields getClimateFloats does not already carry
  // (isRaining/isSnowing/isThunderStorming, and real windSpeed(kph)/
  // windAngle(degrees) as distinct from the 0-100% wind-intensity slider
  // above). The other getWeather fields (temperature, humidity, fog, cloud,
  // precipitation, dayLight, nightStrength, desaturation, viewDistance,
  // ambient) are the exact same ClimateFloat values already polled and
  // shown as sliders, so they are deliberately not duplicated here.
  const [liveWeather, setLiveWeather] = useState<{
    isRaining: boolean
    isSnowing: boolean
    isThunderStorming: boolean
    windSpeedKph: number
    windAngleDeg: number
  } | null>(null)

  const { toast } = useToast()
  const confirm = useConfirm()
  const socket = useSocket()

  const [activeSection, setActiveSection] = useState<EventSectionKey>('rain')
  const [sectionQuery, setSectionQuery] = useState('')
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  // Below `lg` the sidebar/content grid collapses to one column, so the full
  // ~18-item nav (plus Recent Actions) renders ABOVE the section you just
  // picked -- reaching it costs a scroll past everything else on the page,
  // every time. Desktop's two-column layout never has this problem. Jumping
  // the content into view on selection is scoped to exactly that narrow
  // case (2026-08-31 quality pass, operator-approved aesthetic fix) rather
  // than restructuring the nav itself, which touches far more of the page.
  const contentRef = useRef<HTMLDivElement>(null)
  const jumpToContentOnMobile = () => {
    // jsdom (every existing test on this page) has no matchMedia at all,
    // unlike WorldMap.tsx's unconditional call to it -- guard rather than
    // require every Events.tsx test file to stub a global just so an
    // unrelated nav click doesn't throw.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    if (window.matchMedia('(max-width: 1023px)').matches) {
      contentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

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
  // Same drag-suppression shape as climateDirtyUntilRef, kept separate (not
  // folded into "climate") since time speed is fetched in a different poll
  // branch (timeRes, not floatsRes) and a shared name here would read as
  // climate state gating an unrelated control.
  const timeSpeedDirtyUntilRef = useRef(0)
  const markTimeSpeedDirty = useCallback(() => {
    timeSpeedDirtyUntilRef.current = Date.now() + 2500
  }, [])

  const checkBridgeStatus = useCallback(async () => {
    try {
      const status = await panelBridgeApi.getStatus()
      if (!mountedRef.current) return
      setBridgeConnected(status.modConnected)
      setBridgeConnectionSummary(status.connection?.summary || null)

      // If connected, fetch secondary data in parallel
      if (status.modConnected) {
        // getWeather is deliberately NOT in this Promise.allSettled batch: it
        // only feeds the small live-conditions strip below, and awaiting it
        // alongside floatsRes/timeRes/utilitiesRes would let a slow or
        // failing weather fetch delay the climate sliders those other reads
        // actually drive. Fired independently so it can only ever add data,
        // never hold up the rest of this poll tick.
        panelBridgeApi.getWeather().then((weatherResult) => {
          if (!mountedRef.current) return
          if (weatherResult.success && weatherResult.data) {
            const w = weatherResult.data
            setLiveWeather({
              isRaining: Boolean(w.isRaining),
              isSnowing: Boolean(w.isSnowing),
              isThunderStorming: Boolean(w.isThunderStorming),
              windSpeedKph: typeof w.windSpeed === 'number' ? w.windSpeed : 0,
              windAngleDeg: typeof w.windAngle === 'number' ? w.windAngle : 0,
            })
          }
        }).catch(() => {})

        const [floatsRes, timeRes, utilitiesRes] = await Promise.allSettled([
          panelBridgeApi.getClimateFloats(),
          panelBridgeApi.getGameTime(),
          panelBridgeApi.getUtilitiesStatus(),
        ])
        if (!mountedRef.current) return

        if (floatsRes.status === 'fulfilled' && floatsRes.value.success && floatsRes.value.data?.floats) {
          const floats = floatsRes.value.data.floats
          const findFloat = (id: number) => floats.find((f: { id: number; value: number; min: number; max: number }) => f.id === id)

          // The server reports each ClimateFloat's real min/max alongside its value;
          // capture it so the sliders below can bind to it instead of a hardcoded range.
          setClimateRanges((prev) => {
            const next = { ...prev }
            for (const id of [3, 4, 5, 6, 8, 12, 0, 2, 9, 10, 11]) {
              const f = findFloat(id)
              if (f) next[id] = { min: f.min, max: f.max }
            }
            return next
          })

          // Don't clobber sliders the user is currently dragging.
          if (Date.now() >= climateDirtyUntilRef.current) {
            setFogIntensity(Math.round((findFloat(5)?.value ?? 0) * 100))
            setWindIntensity(Math.round((findFloat(6)?.value ?? 0) * 100))
            setTemperature(Math.round(findFloat(4)?.value ?? 20))
            setCloudIntensity(Math.round((findFloat(8)?.value ?? 0) * 100))
            setHumidity(Math.round((findFloat(12)?.value ?? 0.5) * 100))
            setPrecipitationIntensity(Math.round((findFloat(3)?.value ?? 0) * 100))
            setDesaturation(Math.round((findFloat(0)?.value ?? 0) * 100))
            setNightStrength(Math.round((findFloat(2)?.value ?? 0) * 100))
            setAmbient(Math.round((findFloat(9)?.value ?? 0) * 100))
            setViewDistance(Math.round((findFloat(10)?.value ?? 0) * 100))
            setDayLight(Math.round((findFloat(11)?.value ?? 0) * 100))
          }
        }

        if (timeRes.status === 'fulfilled' && timeRes.value.success && timeRes.value.data) {
          setGameHour(Math.floor(timeRes.value.data.hour))
          setGameDay(timeRes.value.data.day)
          setGameMonth(timeRes.value.data.month)
          // getGameTime's multiplier field reads the same zombie.GameTime
          // singleton RCON's setTimeSpeed command writes to (confirmed via
          // the real jar: SetTimeSpeedCommand calls
          // GameTime.getInstance().setMultiplier(), the exact object/field
          // this reads) -- a real, authoritative read-back, not a decorative
          // one. Without this the slider was local-only useState(1), never
          // reassigned by any fetch, and could show a stale multiplier
          // after any change made outside the panel (RCON, another admin,
          // a restart).
          if (
            typeof timeRes.value.data.multiplier === 'number' &&
            Date.now() >= timeSpeedDirtyUntilRef.current
          ) {
            setTimeSpeed(timeRes.value.data.multiplier)
          }
        }

        if (utilitiesRes.status === 'fulfilled' && utilitiesRes.value.success && utilitiesRes.value.data) {
          setUtilitiesStatus(utilitiesRes.value.data)
        }
      } else {
        // The bridge went offline -- a last-known-good reading here would keep
        // rendering its old green/red "Online"/"Offline" badge (just dimmed by
        // the panel's opacity-60) instead of falling back to the neutral
        // "Pending" state, letting an admin mistake a stale reading for a live
        // one. Clear it so the UI honestly reflects "we don't currently know."
        setUtilitiesStatus(null)
      }
    } catch (error) {
      if (mountedRef.current) {
        setBridgeConnected(false)
        setBridgeConnectionSummary(t('toasts.unableToReadBridgeStatus'))
        setUtilitiesStatus(null)
      }
    }
  }, [])

  // Same getWeather() read as checkBridgeStatus's own poll tick above, split
  // out so a toggle that just changed weather state can reconcile with the
  // real result immediately after its command resolves, instead of waiting
  // for the next scheduled 10s poll -- see the snow/rain StateToggles below.
  // Failure is swallowed the same way checkBridgeStatus's own read already
  // does: a failed reconcile just leaves whatever value is already showing
  // (the optimistic flip, on a fresh toggle) until the next poll tries again.
  const refetchWeather = useCallback(async () => {
    try {
      const weatherResult = await panelBridgeApi.getWeather()
      if (!mountedRef.current) return
      if (weatherResult.success && weatherResult.data) {
        const w = weatherResult.data
        setLiveWeather({
          isRaining: Boolean(w.isRaining),
          isSnowing: Boolean(w.isSnowing),
          isThunderStorming: Boolean(w.isThunderStorming),
          windSpeedKph: typeof w.windSpeed === 'number' ? w.windSpeed : 0,
          windAngleDeg: typeof w.windAngle === 'number' ? w.windAngle : 0,
        })
      }
    } catch {
      // Swallowed -- see comment above.
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

  // bug-hunt-2026-09-04/06 (activeServerChanged sweep): this page never
  // re-read the active server after mount -- same gap as Console.tsx/
  // Dashboard.tsx before their own fixes. Player roster and bridge
  // connectivity are read-only displays with no unsaved-edit risk (already
  // polled every 30s/10s above, so this is only about closing that window
  // immediately rather than introducing a new fetch), so this reloads
  // unconditionally, matching the Console-shape precedent. The bridge
  // options effect (safehouses/factions/vehicles) already depends on
  // `bridgeConnected`, so it re-runs on its own once checkBridgeStatus()
  // picks up the new server's connectivity -- no separate handling needed.
  useEffect(() => {
    if (!socket) return
    const handleActiveServerChanged = () => {
      fetchPlayers()
      checkBridgeStatus()
    }
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, fetchPlayers, checkBridgeStatus])

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
    const shouldLoadVehicles = activeSection === 'vehicles'
    const loadBridgeOptions = async () => {
      setBridgeOptionsLoading(true)
      try {
        const [safehouseResult, factionResult, vehicleResult] = await Promise.allSettled([
          panelBridgeApi.sendCommand('getSafehouses', {}),
          panelBridgeApi.sendCommand('getFactions', {}),
          shouldLoadVehicles ? panelBridgeApi.sendCommand('getVehiclesDetailed', {}) : Promise.resolve(null),
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
          failureReasons.push(t('toasts.sourceSafehouses'))
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
          failureReasons.push(t('toasts.sourceFactions'))
        }

        if (vehicleResult.status === 'fulfilled' && vehicleResult.value) {
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
        } else if (shouldLoadVehicles) {
          failureReasons.push(t('toasts.sourceVehicles'))
        }

        if (failureReasons.length > 0) {
          setBridgeOptionsError(
            failureReasons.length === 3
              ? t('toasts.couldNotRefreshAllLists')
              : t('toasts.couldNotRefreshSomeLists', { sources: failureReasons.join(', ') })
          )
        } else {
          setBridgeOptionsError(null)
        }

        if (updatedAnySource) {
          setBridgeOptionsLastUpdated(formatPanelTimestamp(new Date(), i18n.language))
        }
      } catch {
        if (!active) return
        setBridgeOptionsError(t('toasts.couldNotRefreshAllLists'))
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
  }, [activeSection, bridgeConnected, bridgeOptionsRefreshTick, i18n.language])

  const pushActivity = useCallback((label: string, ok: boolean) => {
    setActivity((prev) => [
      { key: Date.now() + Math.random(), label, ok, at: formatPanelTimestamp(new Date(), i18n.language) },
      ...prev,
    ].slice(0, 6))
  }, [i18n.language])

  // Bridge weather commands
  // onSettled: same additive, opt-in shape as handleAction's own -- see its
  // comment. Added so the snow/rain toggles below can reconcile their own
  // optimistic flip (refetch the real weather on success, revert it on
  // failure) without every OTHER caller of this shared function (Stop All
  // Weather, helicopter, sound/chat actions, ...) growing a weather refetch
  // it has no use for.
  const handleBridgeAction = useCallback(async (action: string, fn: () => Promise<unknown>, onSettled?: (success: boolean) => void | Promise<void>) => {
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
      await onSettled?.(true)
    } catch (error) {
      const message = getUserErrorMessage(error, t('toasts.bridgeCommandFailedFallback'))
      toast({
        title: t('toasts.actionFailedTitle', { action }),
        description: t('toasts.bridgeFailedDesc', { message }),
        variant: 'destructive',
      })
      pushActivity(t('toasts.actionFailedTitle', { action }), false)
      await onSettled?.(false)
    } finally {
      setBridgeLoading(null)
    }
  }, [toast, pushActivity, t])

  const executeCommand = useCallback(async (command: string) => {
    // rconService.execute()'s failures resolve { success: false, error }
    // rather than throwing, but handleResponse() throws on any 200 body
    // with success: false anyway (see lib/api.ts) -- this never sees
    // result.success === false, the throw below is unreachable.
    return rconApi.execute(command)
  }, [])

  // `fn` normally resolves to something this function doesn't inspect (RCON
  // commands, vehicle spawns, etc. -- no verify concept). A handler that DOES
  // need to override the generic success toast (createHorde/createHorde2
  // below, when the mod couldn't confirm the spawn -- see
  // panelBridgeSpawnHordeFabricatedCount.test.js) resolves to
  // `{ toastOverride }` instead -- runtime-checked here rather than widening
  // `fn`'s type, so every other caller is unaffected.
  // onSettled is optional and additive -- every existing caller that doesn't
  // pass one is unaffected. It exists so a caller driving a state-reflecting
  // toggle (e.g. the rain StateToggle below) can reconcile its own optimistic
  // UI flip with the real outcome (refetch on success, revert on failure)
  // without this function needing to know what "the right state" is for
  // every one of its many callers (teleport, spawn, quick sounds, ...).
  const handleAction = useCallback(async (action: string, fn: () => Promise<unknown>, onSettled?: (success: boolean) => void | Promise<void>) => {
    setLoading(action)
    try {
      const result = await fn()
      const override =
        result && typeof result === 'object' && 'toastOverride' in result
          ? (result as { toastOverride: { title: string; description?: string; variant?: 'default' | 'destructive' | 'success' } }).toastOverride
          : null
      if (override) {
        toast(override)
        pushActivity(override.title, true)
      } else {
        const successCopy = getEventSuccessCopy(action, t)
        toast({
          title: successCopy.title,
          description: successCopy.description,
          variant: 'success' as const,
        })
        pushActivity(successCopy.title, true)
      }
      await onSettled?.(true)
    } catch (error) {
      const message = getUserErrorMessage(error, t('toasts.commandFailedFallback'))
      toast({
        title: t('toasts.actionFailedTitle', { action }),
        description: t('toasts.commandFailedDesc', { message }),
        variant: 'destructive',
      })
      pushActivity(t('toasts.actionFailedTitle', { action }), false)
      await onSettled?.(false)
    } finally {
      setLoading(null)
    }
  }, [toast, pushActivity, t])

  const handleUtilities = useCallback(async (action: string, on: boolean, power: boolean, water: boolean) => {
    setLoading(action)
    try {
      const result = on
        ? await panelBridgeApi.restoreUtilities(power, water)
        : await panelBridgeApi.shutOffUtilities(power, water)
      await checkBridgeStatus()
      const successCopy = getEventSuccessCopy(action, t)
      // restoreUtilities/shutOffUtilities already compute the REAL post-
      // action power state via world:isHydroPowerOn() (a genuine read-back,
      // not a hardcoded literal -- see panelBridgeUtilitiesHydroPowerOnReporting
      // .test.js) and return it unconditionally alongside `success: true`.
      // The Lua's own comments ("applySettings can re-roll the modifier" /
      // "so it can't be overwritten") describe exactly the case where the
      // write silently doesn't stick -- until now the client never looked
      // at hydroPowerOn, so a silent no-op still read back as plain success.
      // Water has no equivalent boolean read-back in this response (see
      // PanelBridge.lua's "Water has no Java flag like isHydroPowerOn()"
      // comment) -- only power's outcome can be verified this way.
      //
      // `persisted`/`persistReason` are NOT Lua fields -- since 5aaf2c3e
      // (2026-08-02) panelBridge.js's /utilities/restore and /utilities
      // /shutoff routes call persistUtilities() (Node-side, writes
      // SandboxVars.lua directly) and merge its { persisted, persistReason }
      // into the JSON response alongside the Lua handler's own result. A
      // 2026-08-30 audit ("Finding C") checked only the Lua handler's raw
      // result -- which never carries these fields -- concluded the warning
      // below was dead code, and deleted it in 2d7cca63. It was live: a
      // false `persisted` here is a genuine "this will not survive a server
      // restart" signal on the wire today. Restored 2026-09-04.
      const powerMismatch = power && typeof result?.hydroPowerOn === 'boolean' && result.hydroPowerOn !== on
      const notPersisted = result?.persisted === false
      toast({
        title: powerMismatch ? t('toasts.actionFailedTitle', { action }) : successCopy.title,
        description: powerMismatch
          ? t('toasts.powerDidNotTakeEffectDesc', {
              state: result.hydroPowerOn ? t('utilities.statusOnline') : t('utilities.statusOffline'),
            })
          : notPersisted
            ? t('toasts.notPersistedDesc', { reason: result.persistReason || t('toasts.notPersistedUnknownReason') })
            : successCopy.description,
        variant: powerMismatch ? 'destructive' : notPersisted ? 'default' : ('success' as const),
      })
      pushActivity(powerMismatch ? t('toasts.actionFailedTitle', { action }) : successCopy.title, !powerMismatch)
    } catch (error) {
      const message = getUserErrorMessage(error, t('toasts.commandFailedFallback'))
      toast({
        title: t('toasts.actionFailedTitle', { action }),
        description: t('toasts.commandFailedDesc', { message }),
        variant: 'destructive',
      })
      pushActivity(t('toasts.actionFailedTitle', { action }), false)
    } finally {
      setLoading(null)
    }
  }, [toast, checkBridgeStatus, pushActivity, t])

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
    if (players.length === 0) throw new Error(t('toasts.noPlayersOnlineError'))
    return players[Math.floor(Math.random() * players.length)].name
  }

  // Reports verified:false (never surfaced as ok:false -- see
  // panelBridgeSpawnHordeFabricatedCount.test.js) when the spawned count was
  // fabricated from a fallback rather than read back from
  // VirtualZombieManager. Builds the handleAction toastOverride so
  // "Horde created" doesn't imply a count the mod couldn't actually confirm.
  const hordeToastOverride = (
    actionKey: 'spawnHordeNearPlayer' | 'spawnHordeBehindPlayer',
    actionLabel: string,
    response: { data?: { verified?: unknown } | null } | undefined,
  ) => {
    const state = getBridgeVerifiedState(actionKey, response?.data)
    if (state === 'unverifiable') {
      return { toastOverride: { title: actionLabel, description: t('toasts.bridgeUnverifiedDesc', { action: actionLabel }), variant: 'default' as const } }
    }
    if (state === 'old-bridge') {
      return { toastOverride: { title: actionLabel, description: t('toasts.bridgeOldBridgeDesc', { action: actionLabel }), variant: 'default' as const } }
    }
    return undefined
  }

  // Zombie commands — use PanelBridge (CreateSwarm) for proper distance control
  const createHorde = async (count: number, username?: string) => {
    if (!username) throw new Error(t('toasts.targetPlayerRequiredHorde'))
    const response = await panelBridgeApi.spawnHordeNear(username, count)
    return hordeToastOverride('spawnHordeNearPlayer', getEventSuccessCopy('Create horde', t).title, response)
  }

  // Spawn horde behind the player based on their facing direction
  const createHorde2 = async (count: number, username?: string) => {
    if (!username) throw new Error(t('toasts.targetPlayerRequiredHorde'))
    const response = await panelBridgeApi.spawnHordeBehind(username, count)
    return hordeToastOverride('spawnHordeBehindPlayer', getEventSuccessCopy('Create horde (behind)', t).title, response)
  }

  // Clear all zombies from loaded cells
  const removeZombies = () => panelBridgeApi.clearAllZombies()

  // Clear zombies within a radius of one player -- same reversible-but-
  // affects-someone-else tier as clearAllZombies (zombies respawn over
  // time), just scoped to one player's fight instead of every loaded cell.
  const removeZombiesNear = (username: string) => panelBridgeApi.clearZombiesNearPlayer(username, clearZombiesRadius)

  // Time commands
  // CORRECTED 2026-08-30 (panelbridge-audit): this comment used to claim the
  // PanelBridge GameTime multiplier "does not speed up the dedicated server
  // clock" -- checked against the real jar rather than trusted, and it's
  // wrong. SetTimeSpeedCommand.class's own method refs are
  // GameTime.getInstance() -> GameTime.setMultiplier(), the exact same
  // singleton and field PanelBridge.lua's getGameTime/getTimeSpeed read via
  // gt:getMultiplier(). RCON's setTimeSpeed IS the authoritative multiplier,
  // not a separate, disconnected value -- which is why reading it back
  // (getGameTime's poll, below) is safe to treat as real state.
  const setGameTimeSpeed = () => executeCommand(`setTimeSpeed ${timeSpeed}`)

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
    const form = bridgeOperationForms[operation]
    if (!form || form.fields.length === 0) return {}

    const values = bridgeOperationFormValues[operation] ?? {}
    const missingRequired = form.fields.find((field) => field.required && !String(values[field.key] ?? '').trim())
    if (missingRequired) {
      throw new Error(t('toasts.fieldRequired', { label: missingRequired.label }))
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
          throw new Error(t('toasts.fieldMustBeNumber', { label: field.label }))
        }
        if (typeof field.min === 'number' && n < field.min) {
          throw new Error(t('toasts.fieldMinValue', { label: field.label, min: field.min }))
        }
        if (typeof field.max === 'number' && n > field.max) {
          throw new Error(t('toasts.fieldMaxValue', { label: field.label, max: field.max }))
        }
        args[field.key] = n
      } else if (field.type === 'boolean') {
        args[field.key] = trimmed === 'true'
      } else {
        if (typeof field.maxLength === 'number' && trimmed.length > field.maxLength) {
          throw new Error(t('toasts.fieldMaxLength', { label: field.label, maxLength: field.maxLength }))
        }
        if (field.pattern && !field.pattern.test(trimmed)) {
          throw new Error(field.patternHint || t('toasts.fieldInvalidFormat', { label: field.label }))
        }
        args[field.key] = trimmed
      }
    }

    return args
  }

  const bridgeActiveGroup = bridgeOperationGroups.find((group) => (group.operations as readonly string[]).includes(bridgeOperation))
  const currentBridgeForm = bridgeOperationForms[bridgeOperation]
  const currentBridgeFields = currentBridgeForm?.fields ?? []
  const currentBridgeHasComboFields = currentBridgeFields.some((field) => field.type === 'combo')
  const currentRequiredFieldCount = currentBridgeFields.filter((field) => field.required).length
  const currentCompletedRequiredFieldCount = currentBridgeFields.filter((field) => {
    if (!field.required) return false
    return Boolean(getBridgeFieldValue(field.key).trim())
  }).length
  const bridgeRunDisabledReason = !bridgeConnected
    ? t('bridgeOps.bridgeOfflineReason')
    : bridgeLoading !== null
      ? t('bridgeOps.operationInProgressReason')
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
      // Values stay the literal English strings sent to BanSystem as the RCON
      // reason argument — only the visible label is translated — so they must
      // keep matching each form's `defaultValue` (also English) exactly.
      return [
        { value: 'Rule violation', label: t('operationForms.reasonRuleViolation') },
        { value: 'Abuse', label: t('operationForms.reasonAbuse') },
        { value: 'Harassment', label: t('operationForms.reasonHarassment') },
        { value: 'Cheating', label: t('operationForms.reasonCheating') },
      ]
    }

    return []
  }

  const resetBridgeFormValues = () => {
    const form = bridgeOperationForms[bridgeOperation]
    if (!form) return
    const defaults = Object.fromEntries(form.fields.map((field) => [field.key, field.defaultValue ?? '']))
    setBridgeOperationFormValues((prev) => ({ ...prev, [bridgeOperation]: defaults }))
    setBridgeFormError(null)
  }

  const runInlineAction = async (action: string, args: Record<string, unknown>, label: string) => {
    setBridgeLoading(action)
    try {
      const response = await panelBridgeApi.sendCommand(action, args)
      const verifyState = getBridgeVerifiedState(action, response?.data)
      if (verifyState === 'unverifiable') {
        toast({
          title: label,
          description: t('toasts.bridgeUnverifiedDesc', { action: label }),
          variant: 'default',
        })
      } else if (verifyState === 'old-bridge') {
        toast({
          title: label,
          description: t('toasts.bridgeOldBridgeDesc', { action: label }),
          variant: 'default',
        })
      } else {
        toast({
          title: `${label}`,
          description: t('toasts.operationCompletedDesc'),
          variant: 'success' as const,
        })
      }
      pushActivity(label, true)
      // Re-run the current list operation to refresh table data
      if (bridgeResultData?.operation) {
        try {
          const refreshed = await panelBridgeApi.sendCommand(bridgeResultData.operation, {})
          const payload = refreshed?.data ?? refreshed
          setBridgeResultData({
            operation: bridgeResultData.operation,
            success: true,
            data: payload,
            timestamp: formatPanelTimestamp(new Date(), i18n.language),
          })
        } catch { /* ignore refresh failure */ }
      }
      // Also refresh combo options
      setBridgeOptionsRefreshTick((prev) => prev + 1)
    } catch (error) {
      toast({
        title: t('toasts.actionFailedTitle', { action: label }),
        description: getUserErrorMessage(error, t('toasts.operationFailedFallback')),
        variant: 'destructive',
      })
      pushActivity(t('toasts.actionFailedTitle', { action: label }), false)
    } finally {
      setBridgeLoading(null)
    }
  }

  const runBridgeOperation = async () => {
    if (!bridgeConnected) {
      toast({
        title: t('toasts.bridgeNotConnectedTitle'),
        description: t('toasts.bridgeNotConnectedDesc'),
        variant: 'destructive',
      })
      return
    }

    let parsedArgs: Record<string, unknown> = {}
    try {
      parsedArgs = buildBridgeArgsFromForm(bridgeOperation)
      setBridgeFormError(null)
    } catch (error) {
      const message = getUserErrorMessage(error, t('toasts.completeRequiredFieldsFallback'))
      setBridgeFormError(message)
      toast({
        title: t('toasts.missingOrInvalidFieldsTitle'),
        description: message,
        variant: 'destructive',
      })
      return
    }

    // Kick/ban ops are raw-argument bridge commands with no other gate --
    // unlike every other kick/ban entry point in the app (Players.tsx), a
    // mistyped username/IP/SteamID here fires straight at a real player with
    // zero confirmation. Not styled destructive-red: these are reversible
    // via an unban elsewhere, matching the same tier as Players.tsx's own
    // kick/ban dialogs, just a last-look check before it goes out.
    if (['moderationKickUser', 'moderationBanUser', 'moderationBanIP', 'moderationBanSteamID'].includes(bridgeOperation)) {
      const target = String(parsedArgs.username ?? parsedArgs.ip ?? parsedArgs.steamId ?? '')
      const reason = typeof parsedArgs.reason === 'string' ? parsedArgs.reason : ''
      const operationLabel = bridgeOperationTemplates[bridgeOperation]?.label || bridgeOperation
      const ok = await confirm({
        title: t('bridgeOps.moderationConfirmTitle', { operation: operationLabel }),
        description: t('bridgeOps.moderationConfirmDescription', {
          target: target ? t('bridgeOps.moderationConfirmTarget', { target }) : '',
          reason: reason ? t('bridgeOps.moderationConfirmReason', { reason }) : '',
        }),
        confirmLabel: t('bridgeOps.moderationConfirmButton'),
        destructive: false,
      })
      if (!ok) return
    }

    setBridgeLoading(bridgeOperation)
    setBridgeFormError(null)
    try {
      const response = await panelBridgeApi.sendCommand(bridgeOperation, parsedArgs)
      const payload = response?.data ?? response
      setBridgeResultData({
        operation: bridgeOperation,
        success: true,
        data: payload,
        timestamp: formatPanelTimestamp(new Date(), i18n.language),
      })
      setBridgeLastRunAt(formatPanelTimestamp(new Date(), i18n.language))
      // Refresh combo options for list operations
      if (['getSafehouses', 'getFactions', 'getVehiclesDetailed'].includes(bridgeOperation)) {
        setBridgeOptionsRefreshTick((prev) => prev + 1)
      }
      const operationLabel = bridgeOperationTemplates[bridgeOperation]?.label || bridgeOperation
      const verifyState = getBridgeVerifiedState(bridgeOperation, response?.data)
      if (verifyState === 'unverifiable') {
        toast({
          title: t('toasts.operationExecutedSuffix', { label: operationLabel }),
          description: t('toasts.bridgeUnverifiedDesc', { action: operationLabel }),
          variant: 'default',
        })
      } else if (verifyState === 'old-bridge') {
        toast({
          title: t('toasts.operationExecutedSuffix', { label: operationLabel }),
          description: t('toasts.bridgeOldBridgeDesc', { action: operationLabel }),
          variant: 'default',
        })
      } else {
        toast({
          title: t('toasts.operationExecutedSuffix', { label: operationLabel }),
          description: t('toasts.operationCompletedDesc'),
          variant: 'success' as const,
        })
      }
      // Every other bridge action on this page (handleAction, handleBridgeAction,
      // runInlineAction) logs to Recent Actions -- this, the general Bridge
      // Tools "Run Operation" path, was the one gap: it toasted and populated
      // the results table but never called pushActivity, so the sidebar log
      // could sit on "No recent actions" in the same frame as a completed,
      // timestamped operation result (2026-08-31 quality pass).
      pushActivity(operationLabel, true)
    } catch (error) {
      const message = getUserErrorMessage(error, t('toasts.bridgeOperationFailedFallback'))
      // A "failed" bridge command can still carry a rich diagnostic table --
      // e.g. runEventSequence's per-step results/failedCount/executed on a
      // partial failure -- attached to ApiError.data when the server sends
      // one. Hardcoding null here (as this used to) discarded it even when
      // present, leaving BridgeResultDisplay with nothing to build a partial
      // state from regardless of its own rendering logic.
      const data = error instanceof ApiError ? (error.data ?? null) : null
      setBridgeResultData({
        operation: bridgeOperation,
        success: false,
        data,
        error: message,
        timestamp: formatPanelTimestamp(new Date(), i18n.language),
      })
      setBridgeLastRunAt(formatPanelTimestamp(new Date(), i18n.language))
      toast({
        title: t('toasts.bridgeOperationFailedTitle'),
        description: message,
        variant: 'destructive',
      })
      pushActivity(t('toasts.bridgeOperationFailedTitle'), false)
    } finally {
      setBridgeLoading(null)
    }
  }

  const normalizedQuery = sectionQuery.trim().toLowerCase()
  const filteredGroups = EVENT_SECTION_GROUPS
    .map((group) => ({
      group: group.group,
      items: normalizedQuery
        ? group.items.filter((item) =>
            `${item.label} ${item.hint} ${item.keywords} ${group.group}`.toLowerCase().includes(normalizedQuery)
          )
        : group.items,
    }))
    .filter((group) => group.items.length > 0)
  const activeMeta = EVENT_SECTION_INDEX[activeSection]

  const fogBounds = climateSliderBounds(climateRanges[5], 0, 100, 100)
  const windBounds = climateSliderBounds(climateRanges[6], 0, 100, 100)
  const temperatureBounds = climateSliderBounds(climateRanges[4], -30, 45, 1)
  const cloudBounds = climateSliderBounds(climateRanges[8], 0, 100, 100)
  const humidityBounds = climateSliderBounds(climateRanges[12], 0, 100, 100)
  const precipitationBounds = climateSliderBounds(climateRanges[3], 0, 100, 100)
  const desaturationBounds = climateSliderBounds(climateRanges[0], 0, 100, 100)
  const nightStrengthBounds = climateSliderBounds(climateRanges[2], 0, 100, 100)
  const ambientBounds = climateSliderBounds(climateRanges[9], 0, 100, 100)
  const viewDistanceBounds = climateSliderBounds(climateRanges[10], 0, 100, 100)
  const dayLightBounds = climateSliderBounds(climateRanges[11], 0, 100, 100)

  return (
    <div className="mx-auto max-w-[1180px] space-y-5 pb-8 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        eyebrow={t('pageHeader.eyebrow')}
        tone="world"
        icon={<Zap className="w-5 h-5 text-primary" />}
        actions={
          <Button variant="command" onClick={fetchPlayers} className="gap-2 h-9 text-xs font-medium">
            <RefreshCw className="w-3.5 h-3.5" />
            {t('pageHeader.refreshPlayers')}
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
              <span>{t('statusBar.panelBridge')}</span>
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
                {bridgeConnected ? t('statusBar.online') : t('statusBar.offline')}
              </span>
            </div>
            {!bridgeConnected && (
              <Link to="/settings" className="hidden sm:inline-flex text-sm font-medium text-primary hover:text-primary/80 underline-offset-2 hover:underline">
                {t('statusBar.configureLink')}
              </Link>
            )}
          </div>

          {/* Target picker — only for sections whose commands act on a chosen player. */}
          <div className="flex flex-wrap items-center gap-3">
            {TARGETED_SECTIONS.includes(activeSection) && (
              <>
                <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
                  {t('statusBar.eventTarget')}
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
                {t('statusBar.allOnline')}
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
                {t('statusBar.specific')}
              </button>
            </div>
            {!targetAll && (
              <Select value={selectedPlayer} onValueChange={setSelectedPlayer}>
                <SelectTrigger id="event-target-player" aria-label={t('statusBar.selectPlayerAria')} className="h-9 w-[210px] font-mono text-xs">
                  <SelectValue placeholder={t('statusBar.selectPlayerPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {players.length === 0 ? (
                    <div className="px-2 py-1.5 font-mono text-[11px] text-muted-foreground">{t('statusBar.noPlayersOnline')}</div>
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
              <span className="text-xs font-medium opacity-80">{t('statusBar.onlineCount')}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-3 lg:sticky lg:top-4 lg:self-start">
          <div className="relative">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={sectionQuery}
              onChange={(e) => setSectionQuery(e.target.value)}
              placeholder={t('sidebar.searchPlaceholder')}
              aria-label={t('sidebar.searchAria')}
              className="h-9 min-w-0 ps-8 text-sm"
            />
          </div>

          <nav aria-label={t('sidebar.sectionsAria')} className="space-y-3 rounded-md border border-border/60 bg-card p-2">
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
                        onClick={() => {
                          setActiveSection(item.id)
                          jumpToContentOnMobile()
                        }}
                        aria-current={isActive ? 'true' : undefined}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm transition-colors',
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
                            title={t('sidebar.bridgeBadgeTitle')}
                          >
                            {t('sidebar.bridgeBadge')}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            {filteredGroups.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">{t('sidebar.noMatches')}</p>
            )}
          </nav>

          <div className="rounded-md border border-border/60 bg-card">
            <p className="border-b border-border/60 px-3 py-2 text-xs font-semibold text-foreground">{t('sidebar.recentActions')}</p>
            {activity.length > 0 ? (
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
            ) : (
              <p className="px-3 py-3 text-xs text-muted-foreground">{t('sidebar.noRecentActions')}</p>
            )}
          </div>
        </aside>

        <div ref={contentRef} className="min-w-0 space-y-4 scroll-mt-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{activeMeta.label}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{activeMeta.hint}</p>
          </div>

          {activeMeta.needsBridge && !bridgeConnected && (
            <Alert className="border-warning/40 bg-warning/10">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertTitle className="text-warning">{t('bridgeOfflineAlert.title')}</AlertTitle>
              <AlertDescription>
                <Trans
                  i18nKey="bridgeOfflineAlert.description"
                  t={t}
                  components={{
                    1: <Link to="/settings?tab=bridge" className="text-primary underline-offset-2 hover:underline" />,
                  }}
                />
              </AlertDescription>
            </Alert>
          )}

        {activeSection === 'rain' && (
            <TacticalPanel>
              <SectionHeader label={activeMeta.label} sublabel={t('rain.sublabel')} icon={CloudRain} />
              <div className="p-4 space-y-6">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <CloudRain className="w-3.5 h-3.5 text-info" />
                      {t('rain.rainLabel')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-info">{rainIntensity}%</span>
                  </div>
                  <Slider aria-label={t('rain.rainIntensityAria')} value={[rainIntensity]} onValueChange={([val]) => setRainIntensity(val)} min={1} max={100} step={1} />
                  {bridgeConnected ? (
                    // PanelBridge is connected, so liveWeather.isRaining is a real
                    // read of game state -- a genuine toggle. Still fires the RCON
                    // startRain/stopRain commands this section has always used
                    // (not panelBridgeApi's), only the on/off decision changed.
                    <StateToggle
                      icon={CloudRain}
                      label={t('rain.rainLabel')}
                      state={liveWeather ? liveWeather.isRaining : null}
                      onLabel={t('climate.weatherActive')}
                      offLabel={t('climate.weatherInactive')}
                      pendingLabel={t('utilities.statusPending')}
                      disabled={loading !== null}
                      ariaLabel={t('rain.rainLabel')}
                      onToggle={(next) => {
                        // Optimistic flip -- state we ARE currently showing,
                        // not a fake one -- then reconcile with the real
                        // result once the command resolves, rather than
                        // waiting on the next scheduled poll (was ~5s per
                        // the operator's own report on Tower).
                        const previous = liveWeather
                        setLiveWeather((prev) => (prev ? { ...prev, isRaining: next } : prev))
                        handleAction(next ? 'Start rain' : 'Stop rain', next ? startRain : stopRain, async (success) => {
                          if (success) await refetchWeather()
                          else setLiveWeather(previous)
                        })
                      }}
                    />
                  ) : (
                    // PanelBridge is NOT connected -- this section exists specifically
                    // so RCON rain control still works without the bridge, and there is
                    // no RCON query for "is it currently raining" to build a real toggle
                    // from. Two buttons is the honest design here, not a shortcut: state
                    // is genuinely unknowable over this path, so the request's own rule
                    // ("do NOT fake a toggle where the state is unknowable") applies.
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => handleAction('Start rain', startRain)} disabled={loading !== null} className="h-9 gap-2 text-xs font-medium">
                        {loading === 'Start rain' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudRain className="w-3.5 h-3.5" />}
                        {t('rain.startRain')}
                      </Button>
                      <Button variant="outline" onClick={() => handleAction('Stop rain', stopRain)} disabled={loading !== null} className="h-9 gap-2 text-xs font-medium">
                        {loading === 'Stop rain' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudOff className="w-3.5 h-3.5" />}
                        {t('rain.stopRain')}
                      </Button>
                    </div>
                  )}
                </div>

                <div className="space-y-3 pt-4 border-t border-border/40">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <CloudLightning className="w-3.5 h-3.5 text-amber-400" />
                      {t('rain.stormLabel')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-amber-400">{stormDuration}h</span>
                  </div>
                  <Slider aria-label={t('rain.stormDurationAria')} value={[stormDuration]} onValueChange={([val]) => setStormDuration(val)} min={1} max={24} step={1} />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => handleAction('Start storm', startStorm)} disabled={loading !== null} className="h-9 gap-2 text-xs font-medium">
                      {loading === 'Start storm' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudLightning className="w-3.5 h-3.5" />}
                      {t('rain.startStorm')}
                    </Button>
                    <Button variant="outline" onClick={() => handleAction('Stop weather', stopWeather)} disabled={loading !== null} className="h-9 gap-2 text-xs font-medium">
                      {loading === 'Stop weather' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cloud className="w-3.5 h-3.5" />}
                      {t('rain.clearWeather')}
                    </Button>
                  </div>
                </div>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'severe' && (
            <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
              <SectionHeader
                label={activeMeta.label}
                sublabel={bridgeConnected ? t('severe.sublabelOnline') : t('severe.sublabelOffline')}
                icon={Snowflake}
                tone={bridgeConnected ? 'primary' : 'warning'}
                isBridgeOffline={!bridgeConnected}
              />
              <div className="p-4 space-y-6">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Snowflake className="w-3.5 h-3.5 text-info" />
                      {t('severe.blizzardLabel')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-info">{blizzardDuration}h</span>
                  </div>
                  <Slider aria-label={t('severe.blizzardDurationAria')} value={[blizzardDuration]} onValueChange={([val]) => setBlizzardDuration(val)} min={1} max={24} step={1} disabled={!bridgeConnected} />
                  <Button variant="outline" onClick={() => handleBridgeAction('Blizzard', () => panelBridgeApi.triggerBlizzard(blizzardDuration))} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                    {bridgeLoading === 'Blizzard' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Snowflake className="w-3.5 h-3.5" />}
                    {t('severe.triggerBlizzard')}
                  </Button>
                </div>

                <div className="space-y-3 pt-4 border-t border-border/40">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Wind className="w-3.5 h-3.5 text-amber-400" />
                      {t('severe.tropicalLabel')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-amber-400">{tropicalDuration}h</span>
                  </div>
                  <Slider aria-label={t('severe.tropicalDurationAria')} value={[tropicalDuration]} onValueChange={([val]) => setTropicalDuration(val)} min={1} max={24} step={1} disabled={!bridgeConnected} />
                  <Button variant="outline" onClick={() => handleBridgeAction('Tropical Storm', () => panelBridgeApi.triggerTropicalStorm(tropicalDuration))} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                    {bridgeLoading === 'Tropical Storm' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wind className="w-3.5 h-3.5" />}
                    {t('severe.triggerTropical')}
                  </Button>
                </div>

                <div className="space-y-3 pt-4 border-t border-border/40">
                  <StateToggle
                    icon={Snowflake}
                    label={t('severe.snowToggleLabel')}
                    state={liveWeather ? liveWeather.isSnowing : null}
                    onLabel={t('climate.weatherActive')}
                    offLabel={t('climate.weatherInactive')}
                    pendingLabel={t('utilities.statusPending')}
                    disabled={bridgeLoading !== null || !bridgeConnected}
                    ariaLabel={t('severe.snowToggleLabel')}
                    onToggle={(next) => {
                      const previous = liveWeather
                      setLiveWeather((prev) => (prev ? { ...prev, isSnowing: next } : prev))
                      handleBridgeAction(next ? 'Enable Snow' : 'Disable Snow', () => panelBridgeApi.setSnow(next), async (success) => {
                        if (success) await refetchWeather()
                        else setLiveWeather(previous)
                      })
                    }}
                  />
                  <Button variant="outline" onClick={() => handleBridgeAction('Stop All Weather', () => panelBridgeApi.stopWeather())} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium text-destructive/85 hover:text-destructive hover:border-destructive/40">
                    {bridgeLoading === 'Stop All Weather' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cloud className="w-3.5 h-3.5" />}
                    {t('severe.stopAllWeather')}
                  </Button>
                </div>

                <div className="space-y-3 pt-4 border-t border-border/40">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Waves className="w-3.5 h-3.5 text-primary" />
                      {t('severe.frontLabel')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{weatherFrontStrength}%</span>
                  </div>
                  <Slider aria-label={t('severe.frontStrengthAria')} value={[weatherFrontStrength]} onValueChange={([val]) => setWeatherFrontStrength(val)} min={0} max={100} step={5} disabled={!bridgeConnected} />
                  <Select value={weatherFrontType} onValueChange={setWeatherFrontType} disabled={!bridgeConnected}>
                    <SelectTrigger aria-label={t('severe.frontTypeAria')} className="h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">{t('severe.frontStationary')}</SelectItem>
                      <SelectItem value="1">{t('severe.frontCold')}</SelectItem>
                      <SelectItem value="2">{t('severe.frontWarm')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="outline" onClick={() => handleBridgeAction('Generate Weather Front', () => panelBridgeApi.generateWeather(weatherFrontStrength / 100, Number(weatherFrontType)))} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                    {bridgeLoading === 'Generate Weather Front' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Waves className="w-3.5 h-3.5" />}
                    {t('severe.triggerFront')}
                  </Button>
                </div>

                <div className="space-y-3 pt-4 border-t border-border/40">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Plane className="w-3.5 h-3.5 text-primary" />
                      {t('severe.helicopterLabel')}
                    </Label>
                    <HelpTip label={t('severe.helicopterLabel')}>{t('severe.helicopterTip')}</HelpTip>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => handleBridgeAction('Helicopter Event', () => panelBridgeApi.triggerHelicopterEvent())} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Helicopter Event' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plane className="w-3.5 h-3.5" />}
                      {t('severe.triggerHelicopter')}
                    </Button>
                    <Button variant="outline" onClick={() => handleBridgeAction('Stop Helicopter Event', () => panelBridgeApi.stopHelicopterEvent())} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium text-destructive/85 hover:text-destructive hover:border-destructive/40">
                      {bridgeLoading === 'Stop Helicopter Event' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                      {t('severe.stopHelicopter')}
                    </Button>
                  </div>
                </div>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'climate' && (
          <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
            <SectionHeader
              label={activeMeta.label}
              sublabel={bridgeConnected ? t('climate.sublabelOnline') : t('climate.sublabelOffline')}
              icon={Gauge}
              tone={bridgeConnected ? 'primary' : 'warning'}
              isBridgeOffline={!bridgeConnected}
              action={bridgeConnected ? (
                <Button variant="ghost" size="sm" onClick={() => handleBridgeAction('Reset Climate', async () => { const r = await panelBridgeApi.resetClimateOverrides(); climateDirtyUntilRef.current = 0; return r })} disabled={bridgeLoading !== null} className="h-6 px-2 gap-1 text-xs font-medium">
                  <RotateCcw className="w-3 h-3" />
                  {t('climate.reset')}
                </Button>
              ) : undefined}
            />
            <div className="p-4 space-y-4">
              {bridgeConnected && liveWeather && (
                <div className="flex flex-wrap items-center gap-2 pb-3 border-b border-border/40 text-[11px]">
                  <span className="font-medium text-foreground/70">{t('climate.liveConditions')}</span>
                  {liveWeather.isThunderStorming && (
                    <Badge variant="outline" className="gap-1 text-amber-400 border-amber-400/40">
                      <CloudLightning className="w-3 h-3" /> {t('climate.thunderstorm')}
                    </Badge>
                  )}
                  {liveWeather.isSnowing && (
                    <Badge variant="outline" className="gap-1 text-info border-info/40">
                      <Snowflake className="w-3 h-3" /> {t('climate.snowing')}
                    </Badge>
                  )}
                  {liveWeather.isRaining && !liveWeather.isSnowing && (
                    <Badge variant="outline" className="gap-1 text-info border-info/40">
                      <CloudRain className="w-3 h-3" /> {t('climate.raining')}
                    </Badge>
                  )}
                  {!liveWeather.isRaining && !liveWeather.isSnowing && !liveWeather.isThunderStorming && (
                    <Badge variant="outline" className="gap-1 text-muted-foreground">
                      <CloudOff className="w-3 h-3" /> {t('climate.clear')}
                    </Badge>
                  )}
                  <span className="inline-flex items-center gap-1 font-mono tabular-nums text-muted-foreground">
                    <Wind className="w-3 h-3" />
                    {t('climate.windReading', { speed: Math.round(liveWeather.windSpeedKph), angle: Math.round(liveWeather.windAngleDeg) })}
                  </span>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Eye className="w-3.5 h-3.5 text-primary/80" />
                      {t('climate.fog')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{fogIntensity}%</span>
                  </div>
                  <Slider aria-label={t('climate.fogAria')} value={[fogIntensity]} onValueChange={([val]) => { markClimateDirty(); setFogIntensity(val) }} min={fogBounds.min} max={fogBounds.max} step={5} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Wind className="w-3.5 h-3.5 text-primary/80" />
                      {t('climate.wind')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{windIntensity}%</span>
                  </div>
                  <Slider aria-label={t('climate.windAria')} value={[windIntensity]} onValueChange={([val]) => { markClimateDirty(); setWindIntensity(val) }} min={windBounds.min} max={windBounds.max} step={5} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Thermometer className="w-3.5 h-3.5 text-primary/80" />
                      {t('climate.temperature')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{temperature}°C</span>
                  </div>
                  <Slider aria-label={t('climate.temperatureAria')} value={[temperature]} onValueChange={([val]) => { markClimateDirty(); setTemperature(val) }} min={temperatureBounds.min} max={temperatureBounds.max} step={1} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Cloud className="w-3.5 h-3.5 text-primary/80" />
                      {t('climate.clouds')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{cloudIntensity}%</span>
                  </div>
                  <Slider aria-label={t('climate.cloudsAria')} value={[cloudIntensity]} onValueChange={([val]) => { markClimateDirty(); setCloudIntensity(val) }} min={cloudBounds.min} max={cloudBounds.max} step={5} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Droplets className="w-3.5 h-3.5 text-primary/80" />
                      {t('climate.humidity')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{humidity}%</span>
                  </div>
                  <Slider aria-label={t('climate.humidityAria')} value={[humidity]} onValueChange={([val]) => { markClimateDirty(); setHumidity(val) }} min={humidityBounds.min} max={humidityBounds.max} step={5} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <CloudRain className="w-3.5 h-3.5 text-primary/80" />
                      {t('climate.precipitation')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{precipitationIntensity}%</span>
                  </div>
                  <Slider aria-label={t('climate.precipitationAria')} value={[precipitationIntensity]} onValueChange={([val]) => { markClimateDirty(); setPrecipitationIntensity(val) }} min={precipitationBounds.min} max={precipitationBounds.max} step={5} disabled={!bridgeConnected} />
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
                  {t('climate.applyAll')}
                </Button>
              </div>
              <StateToggle
                icon={CloudRain}
                label={t('climate.rainWithPercent', { percent: Math.max(5, precipitationIntensity) })}
                state={liveWeather ? liveWeather.isRaining : null}
                onLabel={t('climate.weatherActive')}
                offLabel={t('climate.weatherInactive')}
                pendingLabel={t('utilities.statusPending')}
                disabled={bridgeLoading !== null || !bridgeConnected}
                ariaLabel={t('climate.precipitation')}
                onToggle={(next) => {
                  const previous = liveWeather
                  setLiveWeather((prev) => (prev ? { ...prev, isRaining: next } : prev))
                  handleBridgeAction(
                    next ? 'Start Rain' : 'Stop Rain',
                    () => next ? panelBridgeApi.startRain(Math.max(0.05, precipitationIntensity / 100)) : panelBridgeApi.stopRain(),
                    async (success) => {
                      if (success) await refetchWeather()
                      else setLiveWeather(previous)
                    },
                  )
                }}
              />
            </div>
          </TacticalPanel>
        )}

        {activeSection === 'visual' && (
          <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
            <SectionHeader
              label={activeMeta.label}
              sublabel={bridgeConnected ? t('visual.sublabelOnline') : t('visual.sublabelOffline')}
              icon={Telescope}
              tone={bridgeConnected ? 'primary' : 'warning'}
              action={bridgeConnected ? (
                <Button variant="ghost" size="sm" onClick={() => handleBridgeAction('Reset Climate', async () => { const r = await panelBridgeApi.resetClimateOverrides(); climateDirtyUntilRef.current = 0; return r })} disabled={bridgeLoading !== null} className="h-6 px-2 gap-1 text-xs font-medium">
                  <RotateCcw className="w-3 h-3" />
                  {t('visual.reset')}
                </Button>
              ) : undefined}
            />
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Telescope className="w-3.5 h-3.5 text-primary/80" />
                      {t('visual.viewDistance')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{viewDistance}%</span>
                  </div>
                  <Slider aria-label={t('visual.viewDistanceAria')} value={[viewDistance]} onValueChange={([val]) => { markClimateDirty(); setViewDistance(val) }} min={viewDistanceBounds.min} max={viewDistanceBounds.max} step={5} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <SunMedium className="w-3.5 h-3.5 text-primary/80" />
                      {t('visual.dayLight')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{dayLight}%</span>
                  </div>
                  <Slider aria-label={t('visual.dayLightAria')} value={[dayLight]} onValueChange={([val]) => { markClimateDirty(); setDayLight(val) }} min={dayLightBounds.min} max={dayLightBounds.max} step={5} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Moon className="w-3.5 h-3.5 text-primary/80" />
                      {t('visual.nightStrength')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{nightStrength}%</span>
                  </div>
                  <Slider aria-label={t('visual.nightStrengthAria')} value={[nightStrength]} onValueChange={([val]) => { markClimateDirty(); setNightStrength(val) }} min={nightStrengthBounds.min} max={nightStrengthBounds.max} step={5} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Contrast className="w-3.5 h-3.5 text-primary/80" />
                      {t('visual.desaturation')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{desaturation}%</span>
                  </div>
                  <Slider aria-label={t('visual.desaturationAria')} value={[desaturation]} onValueChange={([val]) => { markClimateDirty(); setDesaturation(val) }} min={desaturationBounds.min} max={desaturationBounds.max} step={5} disabled={!bridgeConnected} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Lightbulb className="w-3.5 h-3.5 text-primary/80" />
                      {t('visual.ambient')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{ambient}%</span>
                  </div>
                  <Slider aria-label={t('visual.ambientAria')} value={[ambient]} onValueChange={([val]) => { markClimateDirty(); setAmbient(val) }} min={ambientBounds.min} max={ambientBounds.max} step={5} disabled={!bridgeConnected} />
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-3 border-t border-border/40">
                <Button
                  onClick={() => handleBridgeAction('Apply All Visual', async () => {
                    await Promise.all([
                      panelBridgeApi.setClimateFloat(10, viewDistance / 100),
                      panelBridgeApi.setClimateFloat(11, dayLight / 100),
                      panelBridgeApi.setClimateFloat(2, nightStrength / 100),
                      panelBridgeApi.setClimateFloat(0, desaturation / 100),
                      panelBridgeApi.setClimateFloat(9, ambient / 100),
                    ])
                    // Allow the next poll to re-sync from authoritative game state.
                    climateDirtyUntilRef.current = 0
                  })}
                  disabled={bridgeLoading !== null || !bridgeConnected}
                  className="h-9 gap-2 text-xs font-medium"
                >
                  {bridgeLoading === 'Apply All Visual' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Gauge className="w-3.5 h-3.5" />}
                  {t('visual.applyAll')}
                </Button>
              </div>
            </div>
          </TacticalPanel>
        )}

        {activeSection === 'clock' && (
            <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
              <SectionHeader label={activeMeta.label} sublabel={t('clock.sublabel')} icon={Calendar} tone={bridgeConnected ? 'primary' : 'warning'} />
              <div className="p-4 space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      {gameHour >= 6 && gameHour < 20 ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5 text-info" />}
                      {t('clock.hour')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{String(gameHour).padStart(2, '0')}:00</span>
                  </div>
                  <Slider aria-label={t('clock.hourAria')} value={[gameHour]} onValueChange={([val]) => setGameHour(val)} min={0} max={23} step={1} disabled={!bridgeConnected} />
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <Button variant={gameHour === 6 ? 'secondary' : 'outline'} size="sm" onClick={() => setGameHour(6)} disabled={!bridgeConnected} className="h-8 gap-1 text-xs font-medium"><Sunrise className="w-3 h-3" /> {t('clock.dawn')}</Button>
                  <Button variant={gameHour === 12 ? 'secondary' : 'outline'} size="sm" onClick={() => setGameHour(12)} disabled={!bridgeConnected} className="h-8 gap-1 text-xs font-medium"><Sun className="w-3 h-3" /> {t('clock.noon')}</Button>
                  <Button variant={gameHour === 18 ? 'secondary' : 'outline'} size="sm" onClick={() => setGameHour(18)} disabled={!bridgeConnected} className="h-8 gap-1 text-xs font-medium"><Sunset className="w-3 h-3" /> {t('clock.dusk')}</Button>
                  <Button variant={gameHour === 0 ? 'secondary' : 'outline'} size="sm" onClick={() => setGameHour(0)} disabled={!bridgeConnected} className="h-8 gap-1 text-xs font-medium"><Moon className="w-3 h-3" /> {t('clock.midnight')}</Button>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <div className="space-y-1">
                    <Label htmlFor="game-day" className="text-xs font-medium text-muted-foreground">{t('clock.day')}</Label>
                    <Input id="game-day" aria-label={t('clock.dayAria')} type="number" min={1} max={31} value={gameDay} disabled={!bridgeConnected} onChange={(e) => {
                      const parsed = parseInt(e.target.value, 10)
                      if (Number.isNaN(parsed)) { setGameDay(1); return }
                      setGameDay(Math.min(31, Math.max(1, parsed)))
                    }} className="h-9 font-mono text-[12px] tabular-nums" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="game-month" className="text-xs font-medium text-muted-foreground">{t('clock.month')}</Label>
                    <Select value={String(gameMonth)} onValueChange={(v) => setGameMonth(parseInt(v))} disabled={!bridgeConnected}>
                      <SelectTrigger id="game-month" aria-label={t('clock.monthAria')} className="h-9 font-mono text-[12px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">{t('clock.months.1')}</SelectItem>
                        <SelectItem value="2">{t('clock.months.2')}</SelectItem>
                        <SelectItem value="3">{t('clock.months.3')}</SelectItem>
                        <SelectItem value="4">{t('clock.months.4')}</SelectItem>
                        <SelectItem value="5">{t('clock.months.5')}</SelectItem>
                        <SelectItem value="6">{t('clock.months.6')}</SelectItem>
                        <SelectItem value="7">{t('clock.months.7')}</SelectItem>
                        <SelectItem value="8">{t('clock.months.8')}</SelectItem>
                        <SelectItem value="9">{t('clock.months.9')}</SelectItem>
                        <SelectItem value="10">{t('clock.months.10')}</SelectItem>
                        <SelectItem value="11">{t('clock.months.11')}</SelectItem>
                        <SelectItem value="12">{t('clock.months.12')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Button variant="outline" onClick={() => handleBridgeAction('Set Time', () => panelBridgeApi.setGameTime({ hour: gameHour, day: gameDay, month: gameMonth }))} disabled={bridgeLoading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                  {bridgeLoading === 'Set Time' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
                  {t('clock.applyTimeDate')}
                </Button>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'timespeed' && (
            <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
              <SectionHeader label={activeMeta.label} sublabel={t('timespeed.sublabel')} icon={Clock} tone={bridgeConnected ? 'primary' : 'warning'} />
              <div className="p-4 flex flex-col gap-4">
                <p className="text-xs text-muted-foreground/75 leading-relaxed">
                  {t('timespeed.description')}
                </p>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85">{t('timespeed.multiplier')}</Label>
                    <span className="font-mono text-[11px] tabular-nums text-primary">{timeSpeed}x</span>
                  </div>
                  <Slider aria-label={t('timespeed.speedAria')} value={[timeSpeed]} onValueChange={([val]) => { markTimeSpeedDirty(); setTimeSpeed(val) }} min={1} max={100} step={1} />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" onClick={() => { markTimeSpeedDirty(); setTimeSpeed(1) }} variant={timeSpeed === 1 ? 'secondary' : 'outline'} className="h-8 text-xs font-medium tabular-nums">1×</Button>
                  <Button size="sm" onClick={() => { markTimeSpeedDirty(); setTimeSpeed(5) }} variant={timeSpeed === 5 ? 'secondary' : 'outline'} className="h-8 text-xs font-medium tabular-nums">5×</Button>
                  <Button size="sm" onClick={() => { markTimeSpeedDirty(); setTimeSpeed(10) }} variant={timeSpeed === 10 ? 'secondary' : 'outline'} className="h-8 text-xs font-medium tabular-nums">10×</Button>
                  <Button size="sm" onClick={() => { markTimeSpeedDirty(); setTimeSpeed(24) }} variant={timeSpeed === 24 ? 'secondary' : 'outline'} className="h-8 text-xs font-medium tabular-nums">24×</Button>
                </div>
                {/* No explicit variant, matching Apply All Climate/Visual below --
                    all three are the same shape (apply this card's pending changes
                    to the live game) and had no reason in the code for one of the
                    three to be styled differently (2026-08-31 impeccable pass). */}
                <Button onClick={() => handleAction('Set time speed', setGameTimeSpeed)} disabled={loading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium">
                  {loading === 'Set time speed' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
                  {t('timespeed.applySpeed')}
                </Button>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'utilities' && (
          <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
            <SectionHeader
              label={activeMeta.label}
              sublabel={t('utilities.sublabel')}
              icon={Zap}
              tone={bridgeConnected ? 'primary' : 'warning'}
              action={bridgeConnected ? (
                <Button variant="ghost" size="sm" onClick={() => checkBridgeStatus()} className="h-6 px-2 gap-1 text-xs font-medium">
                  <RefreshCw className="w-3 h-3" /> {t('utilities.refresh')}
                </Button>
              ) : undefined}
            />
            <div className="p-4 space-y-4">
              <div className="flex items-start gap-2 rounded border border-amber-400/25 bg-amber-400/[0.05] px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-400/85">
                <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
                <span>{t('utilities.b42Warning')}</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-md border border-border/50 bg-muted/15 p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-foreground/85">
                      <Zap className="w-3.5 h-3.5 text-amber-400" /> {t('utilities.power')}
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
                      {utilitiesStatus === null ? t('utilities.statusPending') : utilitiesStatus.powerOn ? t('utilities.statusOnline') : t('utilities.statusOffline')}
                    </span>
                  </div>
                  {utilitiesStatus !== null && (
                    <p className="font-mono text-[10px] text-muted-foreground/60">
                      {t('utilities.timingReasoning', {
                        modifier: formatShutoffModifier(utilitiesStatus.elecShutModifier, t),
                        day: Math.floor(utilitiesStatus.currentWorldDay),
                        nights: utilitiesStatus.nightsSurvived,
                      })}
                    </p>
                  )}
                  <div className="flex justify-end">
                    <Switch
                      checked={utilitiesStatus?.powerOn === true}
                      onCheckedChange={(checked) => handleUtilities(checked ? 'Restore Power' : 'Shut Off Power', checked, true, false)}
                      disabled={!bridgeConnected || loading !== null || utilitiesStatus === null}
                      aria-label={t('utilities.power')}
                    />
                  </div>
                </div>

                <div className="rounded-md border border-border/50 bg-muted/15 p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-foreground/85">
                      <Droplets className="w-3.5 h-3.5 text-info" /> {t('utilities.water')}
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
                      {utilitiesStatus === null ? t('utilities.statusPending') : utilitiesStatus.waterOn ? t('utilities.statusOnline') : t('utilities.statusOffline')}
                    </span>
                  </div>
                  {utilitiesStatus !== null && (
                    <p className="font-mono text-[10px] text-muted-foreground/60">
                      {t('utilities.timingReasoning', {
                        modifier: formatShutoffModifier(utilitiesStatus.waterShutModifier, t),
                        day: Math.floor(utilitiesStatus.currentWorldDay),
                        nights: utilitiesStatus.nightsSurvived,
                      })}
                    </p>
                  )}
                  <div className="flex justify-end">
                    <Switch
                      checked={utilitiesStatus?.waterOn === true}
                      onCheckedChange={(checked) => handleUtilities(checked ? 'Restore Water' : 'Shut Off Water', checked, false, true)}
                      disabled={!bridgeConnected || loading !== null || utilitiesStatus === null}
                      aria-label={t('utilities.water')}
                    />
                  </div>
                </div>
              </div>
            </div>
          </TacticalPanel>
        )}

        {activeSection === 'quickSounds' && (
            <TacticalPanel tone="warning">
              <SectionHeader label={activeMeta.label} sublabel={t('quickSounds.sublabel')} icon={Volume2} tone="warning" />
              <div className="p-4 space-y-3">
                <p className="font-mono text-[11px] text-muted-foreground/75 leading-relaxed">
                  {t('quickSounds.hint')}
                </p>
                <div className="flex flex-wrap gap-2">
                  <DisabledReason reason={players.length === 0 ? t('quickSounds.noPlayersOnlineTitle') : null}>
                    <Button variant="outline" onClick={() => handleAction('Helicopter', triggerChopper)} disabled={loading !== null || players.length === 0} className="h-9 gap-2 text-xs font-medium">
                      {loading === 'Helicopter' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crosshair className="w-3.5 h-3.5" />}
                      {t('quickSounds.helicopter')}
                    </Button>
                  </DisabledReason>
                  <DisabledReason reason={players.length === 0 ? t('quickSounds.noPlayersOnlineTitle') : null}>
                    <Button variant="outline" onClick={() => handleAction('Gunshot', triggerGunshot)} disabled={loading !== null || players.length === 0} className="h-9 gap-2 text-xs font-medium">
                      {loading === 'Gunshot' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5" />}
                      {t('quickSounds.gunshot')}
                    </Button>
                  </DisabledReason>
                  <DisabledReason reason={players.length === 0 ? t('quickSounds.noPlayersOnlineTitle') : null}>
                    <Button
                      variant="outline"
                      onClick={() => handleAction('Lightning', () => triggerLightning(pickStrikeTarget()))}
                      disabled={loading !== null || players.length === 0}
                      // eslint-disable-next-line local/no-dead-disabled-title -- already split (this file's own precedent, cited in the rule's docs): the disabled-reason (no players online) lives in the DisabledReason wrapper above; this title carries only the enabled-state hint. Marker added 2026-08-27.
                      title={players.length === 0 ? undefined : t('quickSounds.lightningTooltip')}
                      className="h-9 gap-2 text-xs font-medium text-amber-400/90 hover:text-amber-400 hover:border-amber-400/40"
                    >
                      {loading === 'Lightning' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                      {t('quickSounds.lightning')}
                    </Button>
                  </DisabledReason>
                  <DisabledReason reason={players.length === 0 ? t('quickSounds.noPlayersOnlineTitle') : null}>
                    <Button
                      variant="outline"
                      onClick={() => handleAction('Thunder', () => triggerThunder(pickStrikeTarget()))}
                      disabled={loading !== null || players.length === 0}
                      // eslint-disable-next-line local/no-dead-disabled-title -- already split (this file's own precedent, cited in the rule's docs): the disabled-reason (no players online) lives in the DisabledReason wrapper above; this title carries only the enabled-state hint. Marker added 2026-08-27.
                      title={players.length === 0 ? undefined : t('quickSounds.thunderTooltip')}
                      className="h-9 gap-2 text-xs font-medium"
                    >
                      {loading === 'Thunder' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudLightning className="w-3.5 h-3.5" />}
                      {t('quickSounds.thunder')}
                    </Button>
                  </DisabledReason>
                  <Button
                    variant="outline"
                    onClick={() => handleAction('Alarm', triggerAlarm)}
                    disabled={loading !== null}
                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint (this file's own precedent, cited in the rule's docs as "Alarm"); disables only while another quick-sound action is in flight, unrelated to what the title describes. Triaged 2026-08-27.
                    title={t('quickSounds.alarmTooltip')}
                    className="h-9 gap-2 text-xs font-medium"
                  >
                    {loading === 'Alarm' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
                    {t('quickSounds.alarm')}
                  </Button>
                </div>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'targetedSounds' && (
            <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
              <SectionHeader
                label={activeMeta.label}
                sublabel={bridgeConnected ? t('targetedSounds.sublabelOnline') : t('targetedSounds.sublabelOffline')}
                icon={Megaphone}
                tone={bridgeConnected ? 'primary' : 'warning'}
                isBridgeOffline={!bridgeConnected}
              />
              <div className="p-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                        <Target className="w-3.5 h-3.5 text-primary/80" /> {t('targetedSounds.radius')}
                      </Label>
                      <span className="font-mono text-[11px] tabular-nums text-primary">{soundRadius}m</span>
                    </div>
                    <Slider aria-label={t('targetedSounds.radiusAria')} value={[soundRadius]} onValueChange={([val]) => setSoundRadius(val)} min={10} max={300} step={10} disabled={!bridgeConnected} />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                        <Volume2 className="w-3.5 h-3.5 text-primary/80" /> {t('targetedSounds.volume')}
                      </Label>
                      <span className="font-mono text-[11px] tabular-nums text-primary">{soundVolume}</span>
                    </div>
                    <Slider aria-label={t('targetedSounds.volumeAria')} value={[soundVolume]} onValueChange={([val]) => setSoundVolume(val)} min={10} max={300} step={10} disabled={!bridgeConnected} />
                  </div>
                </div>

                <div className="space-y-2 pt-3 border-t border-border/40">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <User className="w-3 h-3" /> {t('targetedSounds.atTargetLocation')}
                    </span>
                    <span className="text-xs font-medium text-muted-foreground/70">
                      {targetAll || !selectedPlayer ? t('targetedSounds.pickSpecificPlayer') : selectedPlayer}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => handleBridgeAction('Gunshot Sound', () => panelBridgeApi.triggerGunshotBridge({ username: selectedPlayer || undefined }))} disabled={bridgeLoading !== null || !bridgeConnected || targetAll || !selectedPlayer} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Gunshot Sound' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5" />}
                      {t('targetedSounds.gunshot')}
                    </Button>
                    <Button variant="outline" onClick={() => handleBridgeAction('Alarm Sound', () => panelBridgeApi.triggerAlarmBridge({ username: selectedPlayer || undefined }))} disabled={bridgeLoading !== null || !bridgeConnected || targetAll || !selectedPlayer} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Alarm Sound' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
                      {t('targetedSounds.alarm')}
                    </Button>
                    <Button variant="outline" onClick={() => handleBridgeAction('Custom Noise', () => panelBridgeApi.createNoise({ username: selectedPlayer, radius: soundRadius, volume: soundVolume }))} disabled={bridgeLoading !== null || !bridgeConnected || targetAll || !selectedPlayer} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Custom Noise' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Megaphone className="w-3.5 h-3.5" />}
                      {t('targetedSounds.noise')}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2 pt-3 border-t border-border/40">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <MapPin className="w-3 h-3" /> {t('targetedSounds.atWorldCoords')}
                    </span>
                    <span className="text-xs font-medium text-muted-foreground/70">
                      {t('targetedSounds.coordRange')}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="sound-world-x" className="text-xs font-medium text-muted-foreground">{t('targetedSounds.x')}</Label>
                      <Input id="sound-world-x" aria-label={t('targetedSounds.worldXAria')} type="number" placeholder="10500" value={soundX} onChange={(e) => setSoundX(e.target.value)} disabled={!bridgeConnected} className="h-9 font-mono text-[12px] tabular-nums" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="sound-world-y" className="text-xs font-medium text-muted-foreground">{t('targetedSounds.y')}</Label>
                      <Input id="sound-world-y" aria-label={t('targetedSounds.worldYAria')} type="number" placeholder="9800" value={soundY} onChange={(e) => setSoundY(e.target.value)} disabled={!bridgeConnected} className="h-9 font-mono text-[12px] tabular-nums" />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => handleBridgeAction('Gunshot at Coords', () => panelBridgeApi.triggerGunshotBridge({ x: soundCoordX as number, y: soundCoordY as number }))} disabled={bridgeLoading !== null || !bridgeConnected || !hasValidSoundCoords} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Gunshot at Coords' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5" />}
                      {t('targetedSounds.gunshot')}
                    </Button>
                    <Button variant="outline" onClick={() => handleBridgeAction('Alarm at Coords', () => panelBridgeApi.triggerAlarmBridge({ x: soundCoordX as number, y: soundCoordY as number }))} disabled={bridgeLoading !== null || !bridgeConnected || !hasValidSoundCoords} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Alarm at Coords' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
                      {t('targetedSounds.alarm')}
                    </Button>
                    <Button variant="outline" onClick={() => handleBridgeAction('Noise at Coords', () => panelBridgeApi.createNoise({ x: soundCoordX as number, y: soundCoordY as number, radius: soundRadius, volume: soundVolume }))} disabled={bridgeLoading !== null || !bridgeConnected || !hasValidSoundCoords} className="h-9 gap-2 text-xs font-medium">
                      {bridgeLoading === 'Noise at Coords' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Megaphone className="w-3.5 h-3.5" />}
                      {t('targetedSounds.noise')}
                    </Button>
                  </div>
                </div>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'horde' && (
            <TacticalPanel tone={bridgeConnected ? 'destructive' : 'warning'} className={!bridgeConnected ? 'opacity-60' : ''}>
              <SectionHeader label={activeMeta.label} sublabel={bridgeConnected ? t('horde.sublabelOnline') : t('horde.sublabelOffline')} icon={Skull} tone={bridgeConnected ? 'destructive' : 'warning'} isBridgeOffline={!bridgeConnected} />
              <div className="p-4 space-y-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Skull className="w-3.5 h-3.5 text-destructive" /> {t('horde.count')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-destructive">{hordeCount}</span>
                  </div>
                  <Slider aria-label={t('horde.sizeAria')} value={[hordeCount]} onValueChange={([val]) => setHordeCount(val)} min={10} max={500} step={10} />
                </div>
                <DisabledReason reason={players.length === 0 ? t('horde.noPlayersOnlineTitle') : !bridgeConnected ? t('horde.bridgeOfflineTitle') : null}>
                  <Button variant="outline" onClick={() => handleAction('Create horde', () => createHorde(hordeCount, pickStrikeTarget()))} disabled={loading !== null || !bridgeConnected || players.length === 0 || (!targetAll && !selectedPlayer)} className="h-9 gap-2 text-xs font-medium">
                    {loading === 'Create horde' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Skull className="w-3.5 h-3.5" />}
                    {t('horde.spawnNear', { target: targetAll ? t('horde.random') : selectedPlayer || t('horde.targetFallback') })}
                  </Button>
                </DisabledReason>
                <DisabledReason reason={players.length === 0 ? t('horde.noPlayersOnlineTitle') : !bridgeConnected ? t('horde.bridgeOfflineTitle') : null}>
                  <Button variant="outline" onClick={() => handleAction('Create horde (behind)', () => createHorde2(hordeCount, pickStrikeTarget()))} disabled={loading !== null || !bridgeConnected || players.length === 0 || (!targetAll && !selectedPlayer)} className="h-9 gap-2 text-xs font-medium">
                    {loading === 'Create horde (behind)' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Skull className="w-3.5 h-3.5" />}
                    {t('horde.spawnBehind', { target: targetAll ? t('horde.random') : selectedPlayer || t('horde.targetFallback') })}
                  </Button>
                </DisabledReason>
                <div className="space-y-2 pt-3 border-t border-border/40">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                      <Skull className="w-3.5 h-3.5 text-warning" /> {t('horde.clearRadius')}
                    </Label>
                    <span className="font-mono text-[11px] tabular-nums text-warning">{clearZombiesRadius}</span>
                  </div>
                  <Slider aria-label={t('horde.clearRadiusAria')} value={[clearZombiesRadius]} onValueChange={([val]) => setClearZombiesRadius(val)} min={10} max={500} step={10} disabled={!bridgeConnected} />
                  <DisabledReason reason={players.length === 0 ? t('horde.noPlayersOnlineTitle') : !bridgeConnected ? t('horde.bridgeOfflineTitle') : null}>
                    <Button variant="outline" onClick={async () => {
                      // Same reversible-but-affects-someone-else tier as
                      // "clear all" -- warning, not destructive-red -- scoped
                      // to one player instead of every loaded cell.
                      const target = targetAll ? null : selectedPlayer
                      const label = target ? t('horde.clearNearConfirmDescTargeted', { player: target }) : t('horde.clearNearConfirmDescRandom')
                      const ok = await confirm({
                        title: t('horde.clearNearConfirmTitle'),
                        description: label,
                        confirmLabel: t('horde.clearNear', { target: target || t('horde.random') }),
                        variant: 'warning',
                      })
                      if (!ok) return
                      handleAction('Clear zombies near player', () => removeZombiesNear(pickStrikeTarget()))
                    }} disabled={loading !== null || !bridgeConnected || players.length === 0 || (!targetAll && !selectedPlayer)} className="h-9 gap-2 text-xs font-medium text-warning hover:text-warning hover:border-warning/50 hover:bg-warning/10">
                      {loading === 'Clear zombies near player' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                      {t('horde.clearNear', { target: targetAll ? t('horde.random') : selectedPlayer || t('horde.targetFallback') })}
                    </Button>
                  </DisabledReason>
                </div>

                <DisabledReason reason={!bridgeConnected ? t('horde.bridgeOfflineTitle') : null}>
                  <Button variant="outline" onClick={async () => {
                    // Instant, world-wide, and every player on the server feels
                    // it -- reversible (zombies respawn) doesn't undo whatever
                    // someone was mid-fight against. Affects-others-but-
                    // reversible tier: warning, not destructive-red, not silent.
                    const ok = await confirm({
                      title: t('horde.removeAllConfirmTitle'),
                      description: t('horde.removeAllConfirmDescription'),
                      confirmLabel: t('horde.clearLoadedZombies'),
                      variant: 'warning',
                    })
                    if (!ok) return
                    handleAction('Remove all zombies', removeZombies)
                  }} disabled={loading !== null || !bridgeConnected} className="h-9 gap-2 text-xs font-medium text-warning hover:text-warning hover:border-warning/50 hover:bg-warning/10">
                    {loading === 'Remove all zombies' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                    {t('horde.clearLoadedZombies')}
                  </Button>
                </DisabledReason>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'vehicles' && (
            <TacticalPanel tone="info">
              <SectionHeader label={activeMeta.label} sublabel={t('vehicles.sublabel')} icon={Car} tone="info" />
              <div className="p-4 space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="vehicle-type-select" className="text-xs font-medium text-muted-foreground">{t('vehicles.vehicle')}</Label>
                  <Select value={selectedVehicle} onValueChange={setSelectedVehicle}>
                    <SelectTrigger id="vehicle-type-select" aria-label={t('vehicles.typeAria')} className="h-9 font-mono text-[12px]">
                      <SelectValue placeholder={t('vehicles.selectPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {vehicles.map((vehicle) => (
                        <SelectItem key={vehicle.id} value={vehicle.id}>{vehicle.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs font-medium text-muted-foreground">{t('vehicles.spawnFor')}</Label>
                    <HelpTip label={t('vehicles.spawnFor')}>{t('vehicles.spawnForTip')}</HelpTip>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {players.length === 0 ? (
                      <p className="font-mono text-[11px] text-muted-foreground/70 italic">{t('vehicles.noPlayersOnline')}</p>
                    ) : players.map((player) => (
                      <DisabledReason key={player.name} reason={!selectedVehicle ? t('vehicles.selectVehicleFirstTitle') : null}>
                        <Button variant="outline" size="sm" onClick={() => handleAction('Spawn vehicle', () => spawnVehicle(selectedVehicle, player.name))} disabled={loading !== null || !selectedVehicle} className="h-8 gap-1.5 text-xs font-medium">
                          <Car className="w-3 h-3" /> {player.name}
                        </Button>
                      </DisabledReason>
                    ))}
                  </div>
                </div>
              </div>
            </TacticalPanel>
        )}

        {activeSection === 'teleport' && (
          <TacticalPanel tone="info">
            <SectionHeader label={activeMeta.label} sublabel={t('teleport.sublabel')} icon={MapPin} tone="info" />
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <div className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                  <Users className="w-3 h-3 text-info" /> {t('teleport.playerToPlayer')}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="teleport-player-select" className="text-xs font-medium text-muted-foreground">{t('teleport.playerToMove')}</Label>
                  <Select value={selectedPlayer} onValueChange={setSelectedPlayer}>
                    <SelectTrigger id="teleport-player-select" aria-label={t('teleport.playerToMoveAria')} className="h-9 font-mono text-[12px]">
                      <SelectValue placeholder={t('teleport.selectPlayerPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {players.length === 0 ? (
                        <div className="px-2 py-1.5 font-mono text-[11px] text-muted-foreground">{t('teleport.noPlayersOnline')}</div>
                      ) : players.map((player) => (
                        <SelectItem key={player.name} value={player.name}>{player.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label id="teleport-target-player-label" className="text-xs font-medium text-muted-foreground">{t('teleport.moveTo')}</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {players.filter(p => p.name !== selectedPlayer).map((player) => (
                      <Button key={player.name} variant="outline" size="sm" onClick={() => handleAction('Teleport', () => teleportPlayerToPlayer(selectedPlayer, player.name))} disabled={loading !== null || !selectedPlayer} className="h-8 text-xs font-medium">
                        {player.name}
                      </Button>
                    ))}
                    {players.length <= 1 && (
                      <p className="font-mono text-[11px] text-muted-foreground/70 italic">{t('teleport.needTwoPlayers')}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="text-xs font-medium text-foreground/85 flex items-center gap-1.5">
                  <Navigation className="w-3 h-3 text-info" /> {t('teleport.toCoordinates')}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="teleport-x" className="text-xs font-medium text-muted-foreground">{t('teleport.x')}</Label>
                    <Input id="teleport-x" aria-label={t('teleport.xAria')} type="number" placeholder="10000" value={teleportX} onChange={(e) => setTeleportX(e.target.value)} className="h-9 font-mono text-[12px] tabular-nums" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="teleport-y" className="text-xs font-medium text-muted-foreground">{t('teleport.y')}</Label>
                    <Input id="teleport-y" aria-label={t('teleport.yAria')} type="number" placeholder="11000" value={teleportY} onChange={(e) => setTeleportY(e.target.value)} className="h-9 font-mono text-[12px] tabular-nums" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="teleport-z" className="text-xs font-medium text-muted-foreground">{t('teleport.z')}</Label>
                      <HelpTip label={t('teleport.z')}>{t('teleport.zTip')}</HelpTip>
                    </div>
                    <Input id="teleport-z" aria-label={t('teleport.zAria')} type="number" placeholder="0" value={teleportZ} onChange={(e) => setTeleportZ(e.target.value)} className="h-9 font-mono text-[12px] tabular-nums" />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => handleAction('Teleport self', () => teleportToCoords(teleportCoordX as number, teleportCoordY as number, teleportCoordZ as number))}
                    disabled={loading !== null || !hasValidTeleportCoords}
                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint (this file's own precedent, cited in the rule's docs as "Teleport Player/Self"); the parenthetical is an always-relevant server-side note, not tied to the disabled condition (invalid coords / action in flight). Triaged 2026-08-27.
                    title={t('teleport.teleportSelfTitle')}
                    className="h-9 gap-2 text-xs font-medium"
                  >
                    {loading === 'Teleport self' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
                    {t('teleport.teleportSelf')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleAction('Teleport player', () => teleportToCoords(teleportCoordX as number, teleportCoordY as number, teleportCoordZ as number, getTargetPlayer()))}
                    disabled={loading !== null || !hasValidTeleportCoords || targetAll || !selectedPlayer}
                    // eslint-disable-next-line local/no-dead-disabled-title -- pure hint (this file's own precedent, cited in the rule's docs as "Teleport Player/Self"); an unconditional action description, no branch of it explains any of the four disable conditions. Triaged 2026-08-27.
                    title={t('teleport.teleportPlayerTitle')}
                    className="h-9 gap-2 text-xs font-medium"
                  >
                    {loading === 'Teleport player' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Navigation className="w-3.5 h-3.5" />}
                    {t('teleport.teleportTarget', { target: selectedPlayer || t('teleport.targetFallback') })}
                  </Button>
                </div>
                <p className="font-mono text-[11px] text-muted-foreground/65 leading-relaxed">
                  {t('teleport.presetsHint')}
                </p>
              </div>
            </div>
          </TacticalPanel>
        )}

        {activeSection === 'broadcast' && (
          <TacticalPanel tone="warning">
            <SectionHeader label={activeMeta.label} sublabel={t('broadcast.sublabel')} icon={Megaphone} tone="warning" />
            <div className="p-4 space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="announcement-message" className="text-xs font-medium text-muted-foreground">{t('broadcast.message')}</Label>
                  <span className={cn(
                    'font-mono text-[10px] tabular-nums',
                    announcement.length > 450 ? 'text-amber-400' : 'text-muted-foreground/65'
                  )}>
                    {t('broadcast.charCount', { count: announcement.length })}
                  </span>
                </div>
                <Input id="announcement-message" aria-label={t('broadcast.messageAria')} placeholder={t('broadcast.placeholder')} value={announcement} onChange={(e) => setAnnouncement(e.target.value)} maxLength={500} className="h-9" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setAnnouncement(t('broadcast.messages.eventWarning'))} className="h-8 gap-1.5 text-xs font-medium">
                  <AlertTriangle className="h-3 w-3 text-amber-400" /> {t('broadcast.presetEventWarning')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAnnouncement(t('broadcast.messages.lootNotice'))} className="h-8 gap-1.5 text-xs font-medium">
                  <Bell className="h-3 w-3 text-primary" /> {t('broadcast.presetLootNotice')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAnnouncement(t('broadcast.messages.hordeAlert'))} className="h-8 gap-1.5 text-xs font-medium">
                  <Navigation className="h-3 w-3 text-destructive" /> {t('broadcast.presetHordeAlert')}
                </Button>
              </div>
              <Button variant="outline" onClick={() => handleAction('Send announcement', sendAnnouncement)} disabled={loading !== null || !announcement.trim()} className="h-9 gap-2 text-xs font-medium">
                {loading === 'Send announcement' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Megaphone className="w-3.5 h-3.5" />}
                {t('broadcast.broadcastMessage')}
              </Button>
            </div>
          </TacticalPanel>
        )}

        {activeSection === 'bridgeOps' && (
          <TacticalPanel tone={bridgeConnected ? 'primary' : 'warning'} className={!bridgeConnected ? 'opacity-95' : ''}>
            <SectionHeader
              label={activeMeta.label}
              sublabel={bridgeConnected ? t('bridgeOps.sublabelOnline', { count: Object.keys(bridgeOperationTemplates).length }) : t('bridgeOps.sublabelOffline')}
              icon={Zap}
              tone={bridgeConnected ? 'primary' : 'warning'}
              isBridgeOffline={!bridgeConnected}
              action={
                <>
                  {bridgeActiveGroup && (
                    <span className="font-mono text-[10px] tracking-[0.14em] text-primary/75">{bridgeActiveGroup.label}</span>
                  )}
                  <span className="text-xs font-medium text-muted-foreground/70">
                    {bridgeLastRunAt ? t('bridgeOps.lastRunPrefix', { time: bridgeLastRunAt }) : t('bridgeOps.neverRun')}
                  </span>
                </>
              }
            />
            <div className="p-4 space-y-4">
                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.35fr)]">
                      <div className="space-y-4">
                        <div className="rounded-lg border border-border/70 bg-muted/25 p-4">
                          <div className="space-y-2">
                            <Label htmlFor="bridge-operation-select">{t('bridgeOps.operationLabel')}</Label>
                            <p className="text-xs leading-5 text-muted-foreground">
                              {t('bridgeOps.operationHint')}
                            </p>
                          </div>
                      <Select
                        value={bridgeOperation}
                        onValueChange={selectBridgeOperation}
                      >
                        <SelectTrigger id="bridge-operation-select" aria-label={t('bridgeOps.operationSelectAria')} disabled={bridgeLoading !== null} className="mt-3">
                          <SelectValue placeholder={t('bridgeOps.operationSelectPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(bridgeOperationTemplates).map(([action, meta]) => (
                            <SelectItem key={action} value={action}>{meta.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                        <div className="mt-3 rounded-md border border-border/60 bg-background/60 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-foreground">{bridgeOperationTemplates[bridgeOperation]?.label}</p>
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                {bridgeOperationTemplates[bridgeOperation]?.description}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border border-border/70 bg-muted/20 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-foreground">{t('bridgeOps.operationGroupsLabel')}</p>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                              {t('bridgeOps.operationGroupsHint')}
                            </p>
                          </div>
                        </div>
                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          {bridgeOperationGroups.map((group) => {
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
                              <p className="text-xs font-medium text-foreground">{t('bridgeOps.quickPicks', { group: bridgeActiveGroup.label })}</p>
                              <Badge variant="outline">{t('bridgeOps.optionsCount', { count: bridgeActiveGroup.operations.length })}</Badge>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {bridgeActiveGroup.operations.map((operationKey) => {
                                const operationMeta = bridgeOperationTemplates[operationKey]
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
                            <Label>{t('bridgeOps.operationInputsLabel')}</Label>
                            <p id="bridge-args-help" className="mt-1 text-xs leading-5 text-muted-foreground">
                              {t('bridgeOps.operationInputsHint')}
                            </p>
                          </div>
                          <Badge variant={bridgeFormError ? 'destructive' : 'outline'}>
                            {bridgeFormError ? t('bridgeOps.needsAttentionBadge') : currentBridgeFields.length === 0 ? t('bridgeOps.noInputsBadge') : t('bridgeOps.readyBadge')}
                          </Badge>
                        </div>

                        {currentRequiredFieldCount > 0 && (
                          <div className="mt-3 rounded-md border border-border/60 bg-background/40 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-xs text-muted-foreground">{t('bridgeOps.requiredFieldsCompleted')}</p>
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
                              {t('bridgeOps.noAdditionalInputs')}
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
                                  <Label htmlFor={fieldId}>{field.label}{field.required ? t('bridgeOps.requiredSuffix') : ''}</Label>
                                  <Select value={value || field.defaultValue || ''} onValueChange={(next) => setBridgeFieldValue(field.key, next)}>
                                    <SelectTrigger id={fieldId}>
                                      <SelectValue placeholder={field.placeholder} />
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
                                  <Label htmlFor={fieldId}>{field.label}{field.required ? t('bridgeOps.requiredSuffix') : ''}</Label>
                                  <Select
                                    value={hasOptions ? value : ''}
                                    onValueChange={(next) => setBridgeFieldValue(field.key, next)}
                                    disabled={bridgeOptionsLoading || !hasOptions}
                                  >
                                    <SelectTrigger id={fieldId}>
                                      <SelectValue
                                        placeholder={
                                          bridgeOptionsLoading
                                            ? t('bridgeOps.loadingServerOptions')
                                            : hasOptions
                                              ? field.placeholder
                                              : t('bridgeOps.noServerOptionsAvailable')
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
                                          {bridgeOptionsLoading ? t('bridgeOps.loadingOptionsFromServer') : t('bridgeOps.noOptionsLoadedYet')}
                                        </div>
                                      )}
                                    </SelectContent>
                                  </Select>
                                  {showManualFallback && (
                                    <Input
                                      value={value}
                                      onChange={(e) => setBridgeFieldValue(field.key, e.target.value)}
                                      placeholder={field.placeholder || t('bridgeOps.manualEntryPlaceholder')}
                                      aria-label={t('bridgeOps.manualEntryAria', { label: field.label })}
                                    />
                                  )}
                                  <p className="text-xs text-muted-foreground">
                                    {hasOptions
                                      ? t('bridgeOps.loadedFromServer')
                                      : bridgeOptionsLoading
                                        ? t('bridgeOps.waitingForData')
                                        : t('bridgeOps.serverListUnavailable')}
                                  </p>
                                </div>
                              )
                            }

                            if (field.type === 'textarea') {
                              return (
                                <div key={field.key} className="space-y-1.5 sm:col-span-2">
                                  <Label htmlFor={fieldId}>{field.label}{field.required ? t('bridgeOps.requiredSuffix') : ''}</Label>
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
                                <Label htmlFor={fieldId}>{field.label}{field.required ? t('bridgeOps.requiredSuffix') : ''}</Label>
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
                                  ? t('bridgeOps.refreshingLists')
                                  : bridgeOptionsError
                                    ? bridgeOptionsError
                                    : bridgeOptionsLastUpdated
                                      ? t('bridgeOps.bridgeListsUpdated', { time: bridgeOptionsLastUpdated })
                                      : t('bridgeOps.bridgeListsNotLoaded')}
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
                                {t('bridgeOps.refreshLists')}
                              </Button>
                            </div>
                          </div>
                        )}

                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs text-muted-foreground">
                            {t('bridgeOps.fieldsPrefilledNote')}
                          </p>
                          <span className="text-xs text-muted-foreground">
                            {bridgeLastRunAt ? t('bridgeOps.lastRun', { time: bridgeLastRunAt }) : t('bridgeOps.notRunYet')}
                          </span>
                        </div>
                      {bridgeConnectionSummary && (
                        <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
                          {t('bridgeOps.bridgeFileLink', { summary: bridgeConnectionSummary })}
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
                      <AlertTitle className="text-warning">{t('bridgeOps.bridgeConnectionRequiredTitle')}</AlertTitle>
                      <AlertDescription>
                        {t('bridgeOps.bridgeConnectionRequiredDesc')}
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
                      {t('bridgeOps.runOperation')}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={resetBridgeFormValues}
                      disabled={bridgeLoading !== null || currentBridgeFields.length === 0}
                      className="h-11"
                    >
                      {t('bridgeOps.resetFields')}
                    </Button>
                    {bridgeResultData && (
                      <Button
                        variant="outline"
                        onClick={() => setBridgeResultData(null)}
                        disabled={bridgeLoading !== null}
                        className="h-11"
                      >
                        {t('bridgeOps.clearResults')}
                      </Button>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    {bridgeRunDisabledReason || t('bridgeOps.readyStatus')}
                  </p>

                  {/* Structured Result Display */}
                  {bridgeResultData && (
                    <BridgeResultDisplay
                      result={bridgeResultData}
                      loading={bridgeLoading}
                      onInlineAction={runInlineAction}
                      players={players}
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
