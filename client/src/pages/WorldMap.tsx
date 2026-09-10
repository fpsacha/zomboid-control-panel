import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { getCurrentLanguage, isRTL } from '@/i18n'
import { useTheme } from '@/contexts/ThemeContext'
import { useSocket } from '@/contexts/SocketContext'
import { useAuth } from '@/contexts/AuthContext'
import { DisabledReason } from '@/components/DisabledReason'
import { HelpTip } from '@/components/HelpTip'
import {
  Map as MapIcon,
  Crosshair,
  Users,
  ZoomIn,
  ZoomOut,
  Maximize2,
  RefreshCw,
  Loader2,
  Heart,
  Skull,
  Shield,
  CloudLightning,
  Volume2,
  X,
  Swords,
  Pill,
  UtensilsCrossed,
  Hammer,
  Wrench,
  Target,
  Car,
  Home,
  Fuel,
  Battery,
  Trash2,
  ChevronUp,
  ChevronDown,
  Layers,
  Zap,
  Plus,
  Copy,
  Locate,
  Package,
  Flame,
  BellRing,
  Megaphone,
  Save,
  AlertTriangle,
  ArrowUpRight,
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { BridgeStatusBadge } from '@/components/BridgeStatusBadge'
import { VehiclePicker } from '@/components/VehiclePicker'
import { ItemPicker } from '@/components/ItemPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NumberInput } from '@/components/NumberInput'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { panelBridgeApi, updateApi, serversApi, mapApi, playersApi, BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS } from '@/lib/api'
import { getBridgeVerifiedState } from '@/lib/bridgeVerify'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useToast } from '@/components/ui/use-toast'
import { cn, copyText } from '@/lib/utils'
import { createInFlightGate } from '@/lib/inFlightGate'
import { resolveFallbackTile, conservativeRenderedMaxLevel } from './worldMapTileFallback'
import { buildTileQuery } from './worldMapTileUrl'
import { mapConfigsEqual } from './worldMapConfigEqual'
import { bridgeSupportsPlayerStatus } from './worldMapBridgeVersion'
import { diagnoseTileFailure, tileFailureCopyKeys, type TileFailureDiagnosis } from './worldMapTileFailureDiagnosis'

const TILE_RETRY_MS = [2_000, 10_000, 60_000] as const

// ─── Types ────────────────────────────────────────────────
interface MapPlayer {
  username: string
  displayName?: string
  x: number // game-tile coordinate
  y: number
  z: number
  health?: number
  isAlive?: boolean
  isInfected?: boolean
  accessLevel?: string
  hunger?: number
  thirst?: number
  fatigue?: number
  // Animation state
  prevX?: number
  prevY?: number
  animProgress?: number
}

/** Shape of a player record as returned by the PanelBridge getServerInfo API */
interface RawBridgePlayer {
  name?: string
  username?: string
  displayName?: string
  x: number
  y: number
  z?: number
  health?: number
  isAlive?: boolean
  isInfected?: boolean
  accessLevel?: string
  hunger?: number
  thirst?: number
  fatigue?: number
}

interface ContextMenu {
  screenX: number
  screenY: number
  worldX: number // game-tile coordinate for actions
  worldY: number
  player?: MapPlayer
  vehicle?: MapVehicle
}

interface AirdropMarker {
  x: number
  y: number
  preset: string
  time: number // Date.now()
}

interface MapVehicle {
  id: number
  x: number
  y: number
  persisted?: boolean
  z?: number
  scriptName?: string
  type?: string
  speedKmh?: number
  batteryCharge?: number
  fuelPct?: number
  alarmed?: boolean
  sirening?: boolean
  trunkLocked?: boolean
}

interface MapSafehouse {
  id: string
  title: string
  owner: string
  x: number
  y: number
  w: number
  h: number
  players: string[]
  playerConnected: boolean
  lastVisited?: string
}

// Airdrop preset definitions. Label/description text lives in the worldMap
// locale under airdropPresets.<id> — see presetLabel/presetDesc below.
const AIRDROP_PRESETS = [
  { id: 'military',  icon: Swords },
  { id: 'medical',   icon: Pill },
  { id: 'food',      icon: UtensilsCrossed },
  { id: 'building',  icon: Hammer },
  { id: 'weapons',   icon: Target },
  { id: 'tools',     icon: Wrench },
] as const

// ─── DZI Map Constants ────────────────────────────────────
// Camera: canvasX = dziPixelX * scale + offset.x
// Map tiles use the browser-direct pzmap.org path when available. The backend
// proxy remains the fallback for cached tiles and restricted browsers.

export interface MapConfig {
  tileUrl: string
  tileSize: number
  fullWidth: number
  fullHeight: number
  maxLevel: number
  // Deepest level actually worth requesting -- maxLevel is the depth a FULL
  // Deep Zoom pyramid would need for these dimensions, not evidence the
  // tile host rendered that deep. Defaults to maxLevel for configs that have
  // no better source (MAP_B41 has no server-side discovery yet); B42 gets a
  // real discovered value from /api/map/resolve. See GH#109 /
  // conv-gh109-worldmap-black.
  renderedMaxLevel: number
  isoX0: number
  isoY0: number
  isoHalfSqr: number
  isoQuarterSqr: number
  defaultCenter: { x: number; y: number }
  defaultScale: number
  label: string
}


const MAP_B42: MapConfig = {
  tileUrl: '/api/map/tiles',
  tileSize: 1024,
  fullWidth: 1157312,
  fullHeight: 509520,
  maxLevel: 21,
  // Placeholder used before /api/map/resolve returns (e.g. first paint every
  // session) -- fails CLOSED to the conservative floor, not the full 21,
  // same as b42ConfigFor's own `??` fallback below. See
  // conservativeRenderedMaxLevel's comment in worldMapTileFallback.ts.
  renderedMaxLevel: conservativeRenderedMaxLevel(21),
  isoX0: 518144,
  isoY0: -69648,
  isoHalfSqr: 32,
  isoQuarterSqr: 16,
  defaultCenter: { x: 640000, y: 205000 },
  defaultScale: 0.002,
  label: 'B42',
}

// The game tile MAP_B42.defaultCenter points at, so the default view stays put
// no matter which build's projection is resolved.
const B42_DEFAULT_CENTER_TILE = { x: 10486.75, y: 6678.75 }

// PZ renders each map build at its own resolution — 42.19.0 is 1157312 wide
// with 1024px tiles, 42.20.0 doubled to 2318656 with 2048px tiles.
//
// The projection origin CANNOT be recovered by rescaling: 42.20.0 is exactly
// 2x the height of 42.19.0 but 4032 px wider, because each build is cropped
// and padded independently. So the backend reads the real origin out of the
// build's own base/map_info.json, matching what pzmap.org's own
// viewer does:
//   imageX = (x0 + (gx - gy) * sqr / 2) / scale
//   imageY = (y0 + (gx + gy) * sqr / 4) / scale
// The MAP_B42 constants above are exactly 42.19.0's values under that formula
// (1036288/2 = 518144, -139296/2 = -69648, 128/2/2 = 32, 128/4/2 = 16).
//
// Only when the backend can't supply the origin do we fall back to the old
// width-ratio guess, which is ~2300 px (~36 tiles) west on 42.20.0.
// Origins for builds we've already read map_info.json for. Lets an older
// panel backend (which doesn't forward the origin yet) still project 42.20.0
// correctly, and keeps the map right if map.projectzomboid.com is briefly
// unreachable. Values are verbatim from <build>/base/map_info.json.
const B42_KNOWN_ORIGINS: Record<
  string,
  { x0: number; y0: number; sqr: number; scale: number }
> = {
  // skip:1 -> scale 1<<1 = 2
  '42.19.0': { x0: 1036288, y0: -139296, sqr: 128, scale: 2 },
  // skip:0 -> scale 1<<0 = 1
  '42.20.0': { x0: 1040384, y0: -139296, sqr: 128, scale: 1 },
}

function b42ConfigFor(info: {
  tileSize: number
  width: number
  height: number
  maxLevel: number
  renderedMaxLevel?: number
  b42Dir?: string
  x0?: number
  y0?: number
  sqr?: number
  scale?: number
}): MapConfig {
  const origin =
    Number.isFinite(info.x0) &&
    Number.isFinite(info.y0) &&
    !!info.sqr &&
    !!info.scale
      ? { x0: info.x0!, y0: info.y0!, sqr: info.sqr!, scale: info.scale! }
      : B42_KNOWN_ORIGINS[info.b42Dir ?? ''] || null

  const k = info.width / MAP_B42.fullWidth

  const isoX0 = origin ? origin.x0 / origin.scale : MAP_B42.isoX0 * k
  const isoY0 = origin ? origin.y0 / origin.scale : MAP_B42.isoY0 * k
  const isoHalfSqr = origin
    ? origin.sqr / 2 / origin.scale
    : MAP_B42.isoHalfSqr * k
  const isoQuarterSqr = origin
    ? origin.sqr / 4 / origin.scale
    : MAP_B42.isoQuarterSqr * k

  const cfg: MapConfig = {
    ...MAP_B42,
    tileSize: info.tileSize,
    fullWidth: info.width,
    fullHeight: info.height,
    maxLevel: info.maxLevel,
    // If the server response predates this field (rolling restart) or a
    // resolve genuinely failed to determine it, fail CLOSED to the
    // conservative floor -- NOT info.maxLevel, which is exactly the
    // inflated, never-actually-rendered ceiling this fix exists to stop
    // trusting. See conservativeRenderedMaxLevel's comment in
    // worldMapTileFallback.ts.
    renderedMaxLevel: info.renderedMaxLevel ?? conservativeRenderedMaxLevel(info.maxLevel),
    isoX0,
    isoY0,
    isoHalfSqr,
    isoQuarterSqr,
    defaultScale: (MAP_B42.defaultScale * MAP_B42.isoHalfSqr) / isoHalfSqr,
    defaultCenter: MAP_B42.defaultCenter,
  }
  cfg.defaultCenter = gameTileToDzi(
    B42_DEFAULT_CENTER_TILE.x,
    B42_DEFAULT_CENTER_TILE.y,
    cfg,
  )
  return cfg
}

const MAP_B41: MapConfig = {
  tileUrl: '/api/map/b41tiles',
  tileSize: 1024,
  fullWidth: 2285184,
  fullHeight: 990400,
  maxLevel: 22, // ceil(log2(2285184)) = 22
  // B41 has no server-side discovery like B42's discoverRenderedMaxLevel
  // (mapProxy.js) -- it's a legacy/frozen build served from a hardcoded
  // directory with no dynamic /resolve geometry today. Uses the same
  // conservativeRenderedMaxLevel floor as B42's own static placeholder
  // (see its comment above) rather than the full (near-certainly-too-deep)
  // maxLevel. The coarser-tile fallback in drawTileWithFallback covers
  // whatever this clamp gets wrong either way. See GH#109 /
  // conv-gh109-worldmap-black.
  renderedMaxLevel: conservativeRenderedMaxLevel(22),
  // Isometric projection from pzmap.org (multiply=2):
  // Origin derived from PxToTileOffset {x:-5577, y:10327}
  isoX0: 1017856,  // (5577 + 10327) * 64
  isoY0: -152000,  // (5577 - 10327) * 32
  isoHalfSqr: 64,  // 32 * multiply(2)
  isoQuarterSqr: 32, // 16 * multiply(2)
  defaultCenter: { x: 1100000, y: 400000 },
  defaultScale: 0.001,
  label: 'B41',
}

const MIN_SCALE = 0.0003        // canvas px per DZI px (zoomed way out)
const MAX_SCALE = 1.0           // canvas px per DZI px (zoomed way in)
const POLL_INTERVAL = 3000
const MARKER_HIT_RADIUS = 14
// How many coarser levels drawTileWithFallback will walk up looking for a
// cached tile to degrade to. See GH#109 / conv-gh109-worldmap-black.
const MAX_FALLBACK_LEVELS = 8

// ─── Cached top-down vehicle icons ────────────────────────
// Top-down car silhouette rendered to offscreen canvases. Much more legible
// on a world map than a side-view Lucide icon. Cache key encodes every visual
// variable so we don't rebuild the path every frame.
const _carIconCache = new Map<string, HTMLCanvasElement>()

interface CarIconOpts {
  color: string
  size: number
  alarmed?: boolean
  sirening?: boolean
  selected?: boolean
}

function getCarIcon(opts: CarIconOpts): HTMLCanvasElement | null {
  const { color, size, alarmed, sirening, selected } = opts
  if (size < 2) return null
  // Pad the canvas so sirens/alarm beacons can bleed outside the body outline
  const pad = Math.ceil(size * 0.2)
  const totalSize = size + pad * 2
  const key = `${color}|${size}|${alarmed ? 1 : 0}|${sirening ? 1 : 0}|${selected ? 1 : 0}`
  let cv = _carIconCache.get(key)
  if (cv) return cv
  cv = document.createElement('canvas')
  cv.width = totalSize
  cv.height = totalSize
  const c = cv.getContext('2d')!

  // Draw on a normalized 24×24 viewport, centered inside the padded canvas.
  c.translate(pad, pad)
  const k = size / 24
  c.scale(k, k)

  // Geometry constants for a top-down sedan silhouette.
  const bodyX = 6, bodyY = 2.5
  const bodyW = 12, bodyH = 19
  const radius = 3.2 // rounded ends

  // 1. Chassis fill — solid colored body with subtle vertical gradient
  const grad = c.createLinearGradient(0, bodyY, 0, bodyY + bodyH)
  grad.addColorStop(0, color)
  grad.addColorStop(0.5, color)
  grad.addColorStop(1, 'rgba(0,0,0,0.55)') // shadowed rear
  c.fillStyle = grad
  roundRectPath(c, bodyX, bodyY, bodyW, bodyH, radius)
  c.fill()

  // 2. Chassis rim — darker outline for definition
  c.strokeStyle = 'rgba(0,0,0,0.75)'
  c.lineWidth = 1
  c.lineJoin = 'round'
  roundRectPath(c, bodyX, bodyY, bodyW, bodyH, radius)
  c.stroke()

  // 3. Specular highlight along the driver-side edge
  c.save()
  c.beginPath()
  roundRectPath(c, bodyX, bodyY, bodyW, bodyH, radius)
  c.clip()
  c.fillStyle = 'rgba(255,255,255,0.14)'
  c.fillRect(bodyX, bodyY, 2.2, bodyH)
  c.restore()

  // 4. Windshield (front) — tinted glass panel
  c.fillStyle = 'rgba(200,230,255,0.35)'
  roundRectPath(c, bodyX + 1.3, bodyY + 3.3, bodyW - 2.6, 4.2, 1.2)
  c.fill()
  c.strokeStyle = 'rgba(0,0,0,0.35)'
  c.lineWidth = 0.6
  c.stroke()

  // 5. Rear window — slightly darker tint
  c.fillStyle = 'rgba(200,230,255,0.22)'
  roundRectPath(c, bodyX + 1.3, bodyY + 11.5, bodyW - 2.6, 3.4, 1.0)
  c.fill()
  c.strokeStyle = 'rgba(0,0,0,0.35)'
  c.stroke()

  // 6. Roof seam (between windows) — suggests the cabin
  c.strokeStyle = 'rgba(0,0,0,0.4)'
  c.lineWidth = 0.5
  c.beginPath()
  c.moveTo(bodyX + 1.3, bodyY + 8.2)
  c.lineTo(bodyX + bodyW - 1.3, bodyY + 8.2)
  c.moveTo(bodyX + 1.3, bodyY + 10.8)
  c.lineTo(bodyX + bodyW - 1.3, bodyY + 10.8)
  c.stroke()

  // 7. Headlights — two warm rectangles at the front (top of icon)
  c.fillStyle = 'rgba(255,235,180,0.92)'
  c.fillRect(bodyX + 1.2, bodyY + 0.6, 2.4, 1.4)
  c.fillRect(bodyX + bodyW - 3.6, bodyY + 0.6, 2.4, 1.4)

  // 8. Tail lights — dim reds at the back (bottom of icon)
  c.fillStyle = 'rgba(220,60,50,0.85)'
  c.fillRect(bodyX + 1.2, bodyY + bodyH - 1.8, 2.2, 1.0)
  c.fillRect(bodyX + bodyW - 3.4, bodyY + bodyH - 1.8, 2.2, 1.0)

  // 9. Four wheels — tiny dark rectangles poking from the sides
  c.fillStyle = 'rgba(15,15,15,0.9)'
  c.fillRect(bodyX - 1, bodyY + 2.8, 1.8, 3.2) // front-left
  c.fillRect(bodyX + bodyW - 0.8, bodyY + 2.8, 1.8, 3.2) // front-right
  c.fillRect(bodyX - 1, bodyY + bodyH - 6, 1.8, 3.2) // rear-left
  c.fillRect(bodyX + bodyW - 0.8, bodyY + bodyH - 6, 1.8, 3.2) // rear-right

  // 10. Selection ring (when clicked/focused via keyboard)
  if (selected) {
    c.strokeStyle = 'rgba(255,255,255,0.85)'
    c.lineWidth = 1.2
    roundRectPath(c, bodyX - 1.8, bodyY - 1.2, bodyW + 3.6, bodyH + 2.4, radius + 1.8)
    c.stroke()
  }

  // 11. Siren lightbar (blue/red alternating blocks on the roof)
  if (sirening) {
    c.fillStyle = 'rgba(80,140,255,1)'
    c.fillRect(bodyX + 2.6, bodyY + 9.1, 3.2, 1.5)
    c.fillStyle = 'rgba(255,70,70,1)'
    c.fillRect(bodyX + bodyW - 5.8, bodyY + 9.1, 3.2, 1.5)
  }

  // 12. Alarm indicator — pulsing amber dot above the roof
  if (alarmed) {
    c.fillStyle = 'rgba(255,170,40,0.95)'
    c.beginPath()
    c.arc(bodyX + bodyW / 2, bodyY - 1.8, 1.8, 0, Math.PI * 2)
    c.fill()
    c.strokeStyle = 'rgba(0,0,0,0.5)'
    c.lineWidth = 0.5
    c.stroke()
  }

  if (_carIconCache.size > 200) _carIconCache.clear()
  _carIconCache.set(key, cv)
  return cv
}

// Small helper so every rounded-rect share uses the same algorithm
function roundRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  c.beginPath()
  c.moveTo(x + rr, y)
  c.lineTo(x + w - rr, y)
  c.quadraticCurveTo(x + w, y, x + w, y + rr)
  c.lineTo(x + w, y + h - rr)
  c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  c.lineTo(x + rr, y + h)
  c.quadraticCurveTo(x, y + h, x, y + h - rr)
  c.lineTo(x, y + rr)
  c.quadraticCurveTo(x, y, x + rr, y)
  c.closePath()
}

// ─── Canvas color palette ─────────────────────────────────
// Reads CSS custom properties so canvas colors follow the active theme.
// Each HSL token is stored as "H S% L%" in the property (no commas).

function hslToken(prop: string, alpha?: number): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(prop).trim()
  if (!raw) return alpha !== undefined ? `rgba(128,128,128,${alpha})` : '#808080'
  return alpha !== undefined ? `hsl(${raw} / ${alpha})` : `hsl(${raw})`
}

/** Resolve all canvas colors from CSS custom properties once per frame. */
function resolveCanvasColors() {
  return {
    background: hslToken('--background'),
    // Landmarks — these stay neutral/white-based since they overlay the map
    landmarkGlow: 'rgba(255,255,255,0.04)',
    landmarkDiamond: hslToken('--foreground', 0.35),
    landmarkLabel: hslToken('--foreground', 0.65),
    // Shadows — structural, theme-independent
    shadowLight: 'rgba(0,0,0,0.4)',
    shadowMedium: 'rgba(0,0,0,0.45)',
    shadowStrong: 'rgba(0,0,0,0.6)',
    shadowDarker: 'rgba(0,0,0,0.7)',
    shadowOpaque: 'rgba(0,0,0,1)',
    // Player markers
    headHighlight: 'rgba(255,255,255,0.3)',
    playerRim: 'rgba(10,12,16,0.92)',
    playerGlyph: 'rgba(10,12,16,0.85)',
    playerInfectedRing: hslToken('--destructive', 0.85),
    adminStar: hslToken('--warning', 0.9),
    healthBarBg: 'rgba(0,0,0,0.5)',
    healthGood: hslToken('--success', 0.8),
    healthWarning: hslToken('--warning', 0.8),
    healthCritical: hslToken('--destructive', 0.8),
    // Player states (used by getPlayerColor)
    playerDefault: hslToken('--info', 0.92),
    playerAdmin: hslToken('--warning', 0.92),
    playerInfected: hslToken('--destructive', 0.92),
    playerDead: hslToken('--muted-foreground', 0.7),
    // Airdrop
    crateBody: hslToken('--accent', 0.92),
    crateBorder: hslToken('--accent', 0.6),
    crateStraps: hslToken('--warning', 0.7),
    airdropRing: hslToken('--warning', 0.4),
    airdropLine: hslToken('--foreground', 0.5),
    airdropCanopyStroke: hslToken('--warning', 0.85),
    airdropCanopyFill: hslToken('--warning', 0.12),
    airdropLabel: hslToken('--warning', 0.9),
    // Empty state
    emptyTitle: hslToken('--foreground', 0.15),
    emptySubtitle: hslToken('--foreground', 0.08),
    // Crosshair
    crosshair: hslToken('--foreground', 0.12),
    // Username label
    usernameLabel: hslToken('--foreground'),
    // Vehicles
    vehicleMarker: hslToken('--info', 0.85),
    vehicleMarkerHover: hslToken('--info', 1),
    vehicleLabel: hslToken('--info', 0.8),
    vehicleGlow: hslToken('--info', 0.15),
    vehicleFuelWarn: hslToken('--warning', 0.85),
    vehicleFuelCrit: hslToken('--destructive', 0.85),
    // Safehouses
    safehouseFill: hslToken('--success', 0.08),
    safehouseStroke: hslToken('--success', 0.45),
    safehouseStrokeActive: hslToken('--success', 0.7),
    safehouseLabel: hslToken('--success', 0.75),
  }
}

type CanvasColors = ReturnType<typeof resolveCanvasColors>

// Known PZ landmarks (game-tile coordinates)
const PZ_LANDMARKS = [
  { name: 'Muldraugh',      gx: 10630, gy:  9800 },
  { name: 'West Point',     gx: 11900, gy:  6900 },
  { name: 'Rosewood',       gx:  8090, gy: 11500 },
  { name: 'Riverside',      gx:  6100, gy:  5400 },
  { name: 'Louisville',     gx: 12700, gy:  1700 },
  { name: 'March Ridge',    gx: 10100, gy: 12700 },
  { name: 'Valley Station', gx: 13200, gy:  5300 },
  { name: 'Fallas Lake',    gx:  7460, gy:  9050 },
  { name: 'Ekron',          gx:   550, gy:  9750 },
  { name: 'Brandenburg',    gx:  2100, gy:  6080 },
  { name: 'Irvington',      gx:  2500, gy: 14250 },
  { name: 'Echo Creek',     gx:  3520, gy: 10930 },
]

// ─── Component ────────────────────────────────────────────
export default function WorldMap() {
  const { t } = useTranslation('worldMap')
  const { theme } = useTheme()
  const socket = useSocket()
  const { can } = useAuth()
  // 2026-08-27 bug-hunt capability trace: most of this page's actions go
  // through POST /panelBridge/command, gated ONLY bridge.command server-side
  // regardless of what the action name implies -- teleport/vehicle-tool/
  // airdrop are NOT players.gm_tools or server.world_events despite sounding
  // like it. bridge.command is admin-only by default (TECHNICIAN_CAPABILITIES
  // omits it even though technician holds players.gm_tools/server.world_events),
  // so gating these on the name-implied capability would show a stock
  // technician an enabled button that 403s on click -- worse than no gate.
  // Only addVehicleAt is genuinely players.gm_tools alone: it hits a
  // dedicated route (POST /players/add-vehicle-at) instead of the passthrough.
  //
  // setGodMode/healPlayer are a THIRD shape: as of an operator ruling
  // (bug-hunt-2026-08-27, reverses server commit c3083d5 from earlier the
  // same day) players.gm_tools ALONE gates them, same as Spawn Vehicle
  // below -- bridge.command is NOT required despite routing through the
  // generic PanelBridge passthrough. c3083d5 had briefly made it "gm_tools
  // AND bridge.command"; the operator ruled bridge.command was only ever an
  // accidental side effect of these two routing through the passthrough,
  // not a deliberate second gate, and requiring it would deny Technician
  // (who holds gm_tools but not bridge.command by default) the GM tools
  // it's meant to have. See server/routes/panelBridge.js's
  // BRIDGE_ACTION_CAPABILITY / GM_TOOLS_ONLY_ACTIONS. Do NOT widen this to
  // any other action on the page -- everything else stays bridge.command
  // alone, same reasoning as always: gating on a capability a route doesn't
  // actually check hides a working control.
  const canRunBridgeCommand = can('bridge.command')
  const canWorldEvents = can('server.world_events')
  const canGmTools = can('players.gm_tools')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapWrapperRef = useRef<HTMLDivElement>(null)
  const animFrameRef = useRef<number>(0)
  const playerFetchGateRef = useRef(createInFlightGate())
  const overlayFetchGateRef = useRef(createInFlightGate())
  const playersRef = useRef<MapPlayer[]>([])
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null)
  const drawRequestRef = useRef<number>(0)
  const canvasColorsRef = useRef<CanvasColors>(resolveCanvasColors())

  const [players, setPlayers] = useState<MapPlayer[]>([])
  const [rosterCollapsed, setRosterCollapsed] = useState(false)
  const [mapCfg, setMapCfg] = useState<MapConfig>(MAP_B42)
  const mapCfgRef = useRef<MapConfig>(MAP_B42)
  const [scale, setScale] = useState(MAP_B42.defaultScale)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  // Not a Radix primitive, so closing it doesn't automatically restore
  // focus. The menu itself auto-focuses its first item on open (see the
  // ref callback below); this half handles the close side, for any of the
  // ~20 call sites that dismiss the menu (Escape, item selection, an
  // action completing, clicking elsewhere) without each needing its own
  // focus() call.
  const contextMenuWasOpenRef = useRef(false)
  useEffect(() => {
    if (contextMenu) {
      contextMenuWasOpenRef.current = true
    } else if (contextMenuWasOpenRef.current) {
      contextMenuWasOpenRef.current = false
      canvasRef.current?.focus()
    }
  }, [contextMenu])
  const [selectedPlayer, setSelectedPlayer] = useState<MapPlayer | null>(null)
  const [bridgeConnected, setBridgeConnected] = useState(false)
  // Inits true (bridge-tri-state sweep, 2026-09-10): checkBridgeStatus sets
  // this true itself once it runs, but that's a mount-effect tick after the
  // first paint -- an init of false let that first paint render "Offline"
  // (bridgeConnected's own default) for one frame before flipping to the
  // loading state BridgeStatusBadge is meant to show instead.
  const [bridgeLoading, setBridgeLoading] = useState(true)
  // Bridge's self-reported PanelBridge.VERSION -- gates the player-status
  // fields (isAlive/isInfected/accessLevel) added in bridge v1.7.39. See
  // worldMapBridgeVersion.ts for why this is a real version comparison
  // rather than inferring support from field presence.
  const [bridgeVersion, setBridgeVersion] = useState<string | null>(null)
  const bridgeVersionRef = useRef<string | null>(null)
  useEffect(() => { bridgeVersionRef.current = bridgeVersion }, [bridgeVersion])
  const [hasActiveServer, setHasActiveServer] = useState(false)
  const [loading, setLoading] = useState(true)
  const [hoveredPlayer, setHoveredPlayer] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, offX: 0, offY: 0 })
  const [cursorWorldPos, setCursorWorldPos] = useState<{ x: number; y: number } | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const actionLoadingRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const hasFittedRef = useRef(false)
  const [airdropMarkers, setAirdropMarkers] = useState<AirdropMarker[]>([])
  const [vehicles, setVehicles] = useState<MapVehicle[]>([])
  const [safehouses, setSafehouses] = useState<MapSafehouse[]>([])
  const [showVehicles, setShowVehicles] = useState(true)
  const [showSafehouses, setShowSafehouses] = useState(true)
  const [hoveredVehicle, setHoveredVehicle] = useState<number | null>(null) // vehicle id
  const vehiclesRef = useRef<MapVehicle[]>([])
  const safehousesRef = useRef<MapSafehouse[]>([])
  const [spawnDialog, setSpawnDialog] = useState<{ x: number; y: number; z: number } | null>(null)
  const [spawnVehicleId, setSpawnVehicleId] = useState('')
  const [dropDialog, setDropDialog] = useState<{ x: number; y: number; z: number } | null>(null)
  // Items staged for the current drop (multi-item packages supported).
  const [dropItems, setDropItems] = useState<Array<{ itemType: string; count: number }>>([
    { itemType: '', count: 1 },
  ])
  const [dropAnnounce, setDropAnnounce] = useState(true)
  const [dropAttractZombies, setDropAttractZombies] = useState(true)
  const [dropSoundRadius, setDropSoundRadius] = useState(150)
  // Last custom drop — enables a "repeat last drop" context menu item
  const [lastDrop, setLastDrop] = useState<{
    items: Array<{ itemType: string; count: number }>
    label: string
  } | null>(null)
  // User-defined item packages persisted in localStorage. Save / load / delete.
  interface DropTemplate {
    id: string
    name: string
    items: Array<{ itemType: string; count: number }>
  }
  const DROP_TEMPLATES_KEY = 'worldmap.customDropTemplates.v1'
  const [dropTemplates, setDropTemplates] = useState<DropTemplate[]>(() => {
    try {
      const raw = localStorage.getItem(DROP_TEMPLATES_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (t) =>
          t &&
          typeof t.id === 'string' &&
          typeof t.name === 'string' &&
          Array.isArray(t.items)
      )
    } catch {
      return []
    }
  })
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null)
  // Confirm-deletion dialog state for custom drop packages.
  const [deleteTemplateId, setDeleteTemplateId] = useState<string | null>(null)
  // Confirm-deletion dialog state for removing a vehicle from the world.
  const [removeVehicleTarget, setRemoveVehicleTarget] = useState<{ id: number; label: string; x: number; y: number } | null>(null)
  const [templateNameInput, setTemplateNameInput] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)
  const persistDropTemplates = useCallback((next: DropTemplate[]) => {
    setDropTemplates(next)
    try {
      localStorage.setItem(DROP_TEMPLATES_KEY, JSON.stringify(next))
    } catch {
      // localStorage full / unavailable — silent
    }
  }, [])
  const [floor, setFloor] = useState(0)    // Published B42 map layers: -1 = basement, 0 = ground, 1-7 = upper floors
  const floorRef = useRef(0)
  const { toast } = useToast()

  // Floor label helper
  const floorLabel = (f: number) =>
    f === 0 ? t('floor.ground') : f > 0 ? t('floor.floorN', { n: f }) : t('floor.basementN', { n: Math.abs(f) })

  // Airdrop preset label/description lookups (icon stays in AIRDROP_PRESETS)
  const presetLabel = useCallback((id: string) => t(`airdropPresets.${id}.label`), [t])
  const presetDesc = useCallback((id: string) => t(`airdropPresets.${id}.desc`), [t])

  // Change floor — clears tile cache since tiles differ per floor
  const changeFloor = useCallback((newFloor: number) => {
    const clamped = Math.max(-1, Math.min(7, newFloor))
    setFloor(clamped)
    floorRef.current = clamped
    // Mark all in-flight loads as orphaned so their callbacks are no-ops
    const oldCache = tileCacheRef.current
    tileCacheRef.current = {}
    // Clean up: any null entries (pending) in old cache will complete
    // but write to the detached object — harmless
    void oldCache
    // Reset failure/backoff state — the new floor's tiles are independent
    // and shouldn't inherit a stale "can't reach upstream" banner.
    tileFailRef.current = {}
    tileFailureCountRef.current = 0
    setTileLoadFailing(false)
    // Trigger redraw
    if (drawRequestRef.current === 0) {
      drawRequestRef.current = requestAnimationFrame(() => { drawRequestRef.current = 0 })
    }
  }, [])

  // Detect B41 vs B42 — check gameVersion + branch. Re-run whenever the
  // active server changes (not just on mount): a panel managing multiple
  // servers can have the active one switched while this page stays
  // mounted, and B41/B42 use entirely different tile endpoints and
  // isometric projection constants — staying on the old config would
  // silently misplace every marker instead of just failing loudly.
  const detectServerVersion = useCallback(async (cancelledRef: { current: boolean }) => {
    try {
      const [statusRes, serverRes] = await Promise.allSettled([
        updateApi.getStatus(),
        serversApi.getResolvedActive(),
      ])
      if (cancelledRef.current) return

      let isB41 = false
      if (serverRes.status === 'fulfilled') {
        setHasActiveServer(!!serverRes.value.server)
      }
      // unknown-window-instances-outside-the-bridge, 2026-09-10: a REJECTED
      // fetch (network blip, momentary API hiccup) is not "confirmed no
      // active server" -- it's "we don't know." Asserting false here used
      // to collapse both into the same value, which cascades hard: every
      // hasActiveServer-gated effect (checkBridgeStatus, fetchPlayerPositions,
      // fetchOverlays, and the cleanup effect that clears players/vehicles/
      // safehouses) treats false as "definitely no server" and tears itself
      // down -- including forcibly zeroing bridgeConnected, an otherwise
      // independent signal that's already correctly fail-closed on its own
      // terms (see fetchPlayerPositions), before it ever gets a chance to
      // report its own honest status. Unlike Docker's dockerAvailable (a
      // 10s poll that self-heals on its own), this only re-runs on mount or
      // an 'activeServerChanged' socket event -- which may not fire again
      // for the rest of this page load -- so a wrong false here can be
      // effectively permanent, silently killing live player/vehicle
      // tracking for a server that may be fully running. Fail open: keep
      // whatever hasActiveServer already was rather than asserting false.
      // On a cold first load with no prior value, this can't do better than
      // the existing false default -- there's nothing to fall back to yet.
      if (statusRes.status === 'fulfilled' && statusRes.value.gameVersion) {
        isB41 = statusRes.value.gameVersion.startsWith('41.')
      }
      if (!isB41 && serverRes.status === 'fulfilled') {
        const branch = serverRes.value.server?.branch
        if (branch && /b41/i.test(branch)) isB41 = true
      }

      // B42 geometry depends on which map build the backend resolved, so it
      // can only be built once that's known.
      const targetCfg = isB41 ? MAP_B41 : b42ConfigFor(await mapApi.resolve())
      if (cancelledRef.current) return
      // Compare the WHOLE config, not just B41/B42 or a hand-picked field
      // list: the initial state is a B42 placeholder, so a label-only check
      // would skip applying the resolved build's real dimensions -- and a
      // partial field list re-arms the identical bug for the next field
      // anyone adds. See mapConfigsEqual's own comment above MapConfig.
      const cur = mapCfgRef.current
      if (mapConfigsEqual(cur, targetCfg)) return

      setMapCfg(targetCfg)
      mapCfgRef.current = targetCfg
      // B41 has no multi-floor tiles — force floor back to 0 so we don't
      // request `.webp` URLs the B41 backend regex rejects (which would
      // 400 every tile and trigger the "tiles not loading" banner with
      // no way for the user to recover, since the floor selector is
      // hidden on B41).
      if (isB41) {
        setFloor(0)
        floorRef.current = 0
      }
      // Clear tile cache and failure state when switching maps — tile
      // URLs and coordinate systems differ entirely so old entries are
      // meaningless (and stale ones would misplace markers).
      tileCacheRef.current = {}
      tileFailRef.current = {}
      tileFailureCountRef.current = 0
      setTileLoadFailing(false)
      // Re-center on the new config's default center
      const el = containerRef.current
      if (el) {
        const s = targetCfg.defaultScale
        const c = targetCfg.defaultCenter
        setScale(s)
        setOffset({
          x: el.clientWidth / 2 - c.x * s,
          y: el.clientHeight / 2 - c.y * s,
        })
      }
    } catch { /* best-effort */ }
  }, [])

  useEffect(() => {
    const cancelledRef = { current: false }
    detectServerVersion(cancelledRef)
    return () => { cancelledRef.current = true }
  }, [detectServerVersion])

  // Re-detect on active server switch, and drop the previous server's
  // player/vehicle/safehouse data so stale markers don't linger under the
  // new server's identity — mirrors the pattern used by Dashboard/Servers/
  // Layout/Settings for this same socket event.
  useEffect(() => {
    if (!socket) return
    const cancelledRef = { current: false }
    const handleActiveServerChanged = () => {
      setPlayers([])
      setVehicles([])
      setSafehouses([])
      setSelectedPlayer(null)
      setContextMenu(null)
      hasFittedRef.current = false
      detectServerVersion(cancelledRef)
    }
    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      cancelledRef.current = true
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, detectServerVersion])

  useEffect(() => {
    if (hasActiveServer) return
    setBridgeConnected(false)
    setBridgeLoading(false)
    setPlayers([])
    setVehicles([])
    setSafehouses([])
    setLoading(false)
  }, [hasActiveServer])

  // Track mounted state to guard async callbacks
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Reduced motion preference
  const prefersReducedMotion = useRef(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    prefersReducedMotion.current = mq.matches
    const handler = (e: MediaQueryListEvent) => { prefersReducedMotion.current = e.matches }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Refs for use in animation loop (avoid stale closures)
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const offsetRef = useRef(offset)
  offsetRef.current = offset
  const airdropMarkersRef = useRef(airdropMarkers)
  airdropMarkersRef.current = airdropMarkers
  useEffect(() => { vehiclesRef.current = vehicles }, [vehicles])
  useEffect(() => { safehousesRef.current = safehouses }, [safehouses])

  // ─── Map tile cache ─────────────────────────────────────
  // 'empty' marks a tile the upstream server confirmed doesn't exist (a
  // real HTTP 404, not a network/proxy failure) — e.g. a sparse/edge tile,
  // or any tile past the real (often much shallower than maxLevel) rendered
  // coverage depth for this build (see mapProxy.js's discoverRenderedMaxLevel
  // and GH#109 / conv-gh109-worldmap-black). Treating a 404 as a load error
  // caused a false "tiles offline" banner and visible view jumps on zoom, so
  // it's tracked as its own state rather than folded into a failure retry —
  // see the status-aware fetch() below, since an <img> tag alone can't
  // distinguish a 404 from any other failure.
  // pzmap.org's own OpenSeadragon viewer renders an 'empty' tile blank too,
  // but that is NOT evidence blank is the right answer here — it is a
  // reference-conformance fact, not a UX one, and it does not survive a real
  // user staring at a black map (GH#109, filed by Everyday44). The
  // requirement this state actually carries is: drawMap must fall back to
  // the nearest cached coarser tile for an 'empty' entry (see
  // drawTileWithFallback / worldMapTileFallback.ts), never draw nothing.
  const tileCacheRef = useRef<Record<string, HTMLImageElement | null | 'empty'>>({})

  // Resolved once per session: lets the browser build direct-to-upstream
  // tile URLs (https://tiles.pzmap.org/<dir>/...) instead of
  // always routing through this server's proxy. Some deployments (e.g. a
  // Kubernetes cluster with a restrictive Gateway API egress policy) block
  // outbound access to tiles.pzmap.org for the panel's own pod while
  // the admin's browser has no such restriction. /api/map/resolve has its
  // own cache + hardcoded fallback server-side, so it responds instantly
  // even when the backend itself can't reach tiles.pzmap.org.
  const mapSourceRef = useRef<{ root: string; b42Dir: string; b41Path: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    mapApi.resolve()
      .then((info) => { if (!cancelled) mapSourceRef.current = info })
      .catch(() => { /* direct loading just won't be attempted; proxy fallback still works */ })
    return () => { cancelled = true }
  }, [])

  // Builds the real tiles.pzmap.org URL for a tile, or null if we
  // haven't resolved enough info yet (falls back to the backend proxy).
  const buildDirectTileUrl = useCallback((level: number, col: number, row: number, floor: number, ext: string) => {
    const src = mapSourceRef.current
    if (!src) return null
    if (mapCfgRef.current === MAP_B41) {
      return `${src.root}/${src.b41Path}/${level}/${col}_${row}.${ext}`
    }
    // Floor is a path segment on the real upstream, not a query param —
    // the ?floor= convention only exists on our own proxy route, which
    // encodes it that way because /tiles/:level/:tile has no :floor segment.
    // No /maps/ segment here -- that's a proxy-route convention, not part of
    // the real upstream path (dropped along with the pzmap.org -> tiles.pzmap.org move).
    return `${src.root}/${src.b42Dir}/base/layer${floor}_files/${level}/${col}_${row}.${ext}`
  }, [])

  // Cap concurrent tile loads to avoid flooding the network
  const pendingTileLoadsRef = useRef(0)
  const MAX_CONCURRENT_TILES = 8

  // Per-tile failure tracking with exponential backoff. The draw loop runs at
  // ~60fps and re-calls loadDziTile() for every visible tile every frame, so
  // without backoff a dead upstream (firewall, DNS failure, 502 from the
  // proxy) results in thousands of retries per second and an apparent
  // "infinite loading" state. See issue #6.
  const tileFailRef = useRef<Record<string, { count: number; nextAt: number }>>({})
  const tileFailureCountRef = useRef(0)
  const [tileLoadFailing, setTileLoadFailing] = useState(false)
  const [tileFailureKind, setTileFailureKind] = useState<'network' | 'coverage'>('network')
  const tileCoverageFailRef = useRef(0)
  // The byte-level diagnosis of the most recent coverage-classified failure
  // (gated the same way as tileFailureDetail below: first failure of a
  // fresh episode). When present it fully replaces the generic coverage
  // hedge in the banner -- see worldMapTileFailureDiagnosis.ts and
  // tileFailureCopyKeys for what each signature means and why an
  // unrecognised one still gets its own honest message instead of being
  // rounded into a guess.
  const [tileByteDiagnosis, setTileByteDiagnosis] = useState<TileFailureDiagnosis | null>(null)
  // The raw diagnostic code behind the most recent tile failure -- surfaced
  // in the banner itself so a report carries its own diagnosis (the X-Tile-
  // Cache header this reads was already on every tile response; nothing
  // ever displayed it, same defect shape as the backupWarning field nobody
  // read). Every request that ever reaches markFailed already went through
  // loadViaProxy (the direct path always retries via proxy before giving
  // up, see loadDziTile's directImg.onerror below), so this header is
  // always the relevant one -- there is no "which path" ambiguity to add.
  const [tileFailureDetail, setTileFailureDetail] = useState<string | null>(null)

  const loadDziTile = useCallback((level: number, col: number, row: number) => {
    const f = floorRef.current
    const key = `${f}/${level}/${col}_${row}`
    if (key in tileCacheRef.current) return
    if (pendingTileLoadsRef.current >= MAX_CONCURRENT_TILES) return
    // Honour per-tile backoff after previous failures.
    const fail = tileFailRef.current[key]
    if (fail && Date.now() < fail.nextAt) return
    tileCacheRef.current[key] = null
    pendingTileLoadsRef.current++

    const markFailed = (
      reason: 'network' | 'coverage' = 'network',
      detail: string = 'no-header',
      diagnosis: TileFailureDiagnosis | null = null,
    ) => {
      if (floorRef.current !== f) return
      // Drop the pending entry so the per-tile backoff guard above is what
      // gates the next retry (rather than the "key in cache" check).
      delete tileCacheRef.current[key]
      const prev = tileFailRef.current[key]
      const count = (prev?.count ?? 0) + 1
      const delay = TILE_RETRY_MS[Math.min(count - 1, TILE_RETRY_MS.length - 1)]
      tileFailRef.current[key] = { count, nextAt: Date.now() + delay }
      // Surface a user-visible warning if many distinct tiles are failing.
      if (count === 1) {
        // Last-write-wins across whichever tile fails FIRST most recently --
        // illustrative of what's currently going wrong, not a claim every
        // failing tile shares one cause. Gated the same way as the counters
        // just below (first failure of a given tile only) to avoid a
        // re-render on every backoff retry of an already-known-failing tile.
        setTileFailureDetail(detail)
        setTileByteDiagnosis(diagnosis)
        tileFailureCountRef.current++
        if (reason === 'coverage') tileCoverageFailRef.current++
        if (tileFailureCountRef.current >= 6) {
          setTileFailureKind(
            tileCoverageFailRef.current * 2 >= tileFailureCountRef.current
              ? 'coverage'
              : 'network',
          )
          setTileLoadFailing(true)
        }
      }
    }

    const markRecovered = () => {
      // Only decrement the global counter when *this* tile was actually in
      // the failure set, otherwise unrelated successful loads would
      // prematurely hide the banner while other tiles are still failing.
      if (tileFailRef.current[key]) {
        delete tileFailRef.current[key]
        if (tileFailureCountRef.current > 0) {
          tileFailureCountRef.current = Math.max(0, tileFailureCountRef.current - 1)
          if (tileFailureCountRef.current === 0) {
            tileCoverageFailRef.current = 0
            setTileLoadFailing(false)
            setTileFailureDetail(null)
            setTileByteDiagnosis(null)
          }
        }
      }
    }

    // Every B42 layer DZI declares JPEG tiles, including upper floors.
    const ext = 'jpg'
    // `v` names the resolved B42 build this URL was built against -- see
    // mapProxy.js's TILE_BROWSER_CACHE_CONTROL_VERSIONED comment. Only
    // meaningful for B42 (B41's upstream directory is a fixed literal, not
    // dynamically resolved, so there's nothing to version there), and only
    // once mapSourceRef's one-shot /resolve() has actually completed --
    // tiles requested before that finishes just miss out on the long-cache
    // upgrade, same as before this change, never a correctness problem.
    const isB41 = mapCfgRef.current === MAP_B41
    const versionDir = !isB41 ? (mapSourceRef.current?.b42Dir ?? null) : null
    const proxyUrl = `${mapCfgRef.current.tileUrl}/${level}/${col}_${row}.${ext}${buildTileQuery(f, versionDir)}`

    // Loads through this server's proxy — the "smart" path that can tell a
    // real 404 (tile genuinely absent — see tileCacheRef's comment above for
    // what 'empty' means and why it must fall back, not render blank) apart
    // from an actual connectivity failure, since an <img> tag alone can't
    // see HTTP status codes. Used directly when we haven't resolved a direct
    // upstream URL yet, and as the fallback when a direct browser load
    // fails for an ambiguous reason (which itself might just be a real
    // 404 — routing it through here resolves that ambiguity).
    //
    // pendingTileLoadsRef is decremented at each actual terminal point
    // (not in a blanket .finally()) so the concurrency cap holds the slot
    // for the full lifecycle including image decode.
    const loadViaProxy = () => {
      // 'coverage' names tiles.pzmap.org in the failure banner; 'network'
      // does not. That distinction must track whether upstream actually
      // participated in THIS response, not just the HTTP status shape --
      // serveTile (mapProxy.js) can fail a request entirely from its own
      // memory/disk cache, never touching tiles.pzmap.org at all, and the
      // banner must not vouch for a host that was never contacted. Only
      // X-Tile-Cache: miss confirms an upstream fetch actually happened;
      // hit-mem/hit-disk/absent all mean "local", regardless of status.
      let upstreamParticipated = false
      // Raw X-Tile-Cache value (hit-mem/hit-disk/miss), kept alongside the
      // derived upstreamParticipated boolean so the failure banner can show
      // the actual diagnostic code rather than just the coarse network/
      // coverage split -- see tileFailureDetail above.
      let cacheTierRaw: string | null = null
      // The response's own declared size -- compared against the blob we
      // actually receive if decoding later fails, to prove truncation
      // rather than guess at it. See worldMapTileFailureDiagnosis.ts.
      let contentLengthHeader: string | null = null
      fetch(proxyUrl)
        .then((res) => {
          cacheTierRaw = res.headers.get('X-Tile-Cache')
          contentLengthHeader = res.headers.get('Content-Length')
          upstreamParticipated = cacheTierRaw === 'miss'
          if (floorRef.current !== f) { pendingTileLoadsRef.current--; return null } // stale — floor changed mid-flight
          if (res.status === 404) {
            pendingTileLoadsRef.current--
            tileCacheRef.current[key] = 'empty'
            markRecovered()
            return null
          }
          if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`) as Error & { status?: number }
            err.status = res.status
            throw err
          }
          return res.blob()
        })
        .then((blob) => {
          if (!blob) return // already handled (stale or 404) above
          if (floorRef.current !== f) { pendingTileLoadsRef.current--; return }
          const objectUrl = URL.createObjectURL(blob)
          const img = new window.Image()
          img.onload = () => {
            URL.revokeObjectURL(objectUrl)
            pendingTileLoadsRef.current--
            if (floorRef.current !== f) return
            tileCacheRef.current[key] = img
            markRecovered()
            if (drawRequestRef.current === 0) {
              drawRequestRef.current = requestAnimationFrame(() => { drawRequestRef.current = 0 })
            }
          }
          img.onerror = () => {
            URL.revokeObjectURL(objectUrl)
            pendingTileLoadsRef.current--
            // Bytes arrived and only the decode failed. If upstream actually
            // sent these bytes this request, naming it is earned ('coverage').
            // If they came from our own cache (hit-mem/hit-disk), the
            // corruption is local and upstream had no part in it.
            //
            // Classifying the blob's own bytes -- already fully in memory,
            // no extra request, no operator devtools relay -- turns this
            // from a hedge into a positive identification of what the
            // response actually was, or an honest "unrecognized, here are
            // the bytes" when it's neither our nor the operator's most
            // likely guess. See worldMapTileFailureDiagnosis.ts.
            blob.slice(0, 4).arrayBuffer()
              .then((buf) => {
                const diagnosis = diagnoseTileFailure(new Uint8Array(buf), blob.size, contentLengthHeader)
                markFailed(upstreamParticipated ? 'coverage' : 'network', cacheTierRaw ?? 'no-header', diagnosis)
              })
              .catch(() => {
                // Reading the blob's own already-in-memory bytes failed --
                // shouldn't happen, but fall back rather than leave this
                // tile's failure unrecorded.
                markFailed(upstreamParticipated ? 'coverage' : 'network', cacheTierRaw ?? 'no-header')
              })
          }
          img.src = objectUrl
        })
        .catch((err) => {
          pendingTileLoadsRef.current--
          const status = (err as { status?: number } | undefined)?.status
          // A readable 4xx WITH upstreamParticipated means we reached
          // upstream and it has no tile there. Anything else -- a 5xx, a
          // rejected fetch (couldn't even reach our own proxy), or a 4xx
          // that never got as far as the upstream fetch (local validation) --
          // means we can't vouch for tiles.pzmap.org either way.
          // Detail: the response's own header when we got one (a 4xx/5xx
          // passthrough still carries it), else `http-<status>` when there
          // was a status but no header, else 'unreachable' for a fetch that
          // never got a response at all (couldn't even reach our own proxy).
          markFailed(
            upstreamParticipated && status && status >= 400 && status < 500 ? 'coverage' : 'network',
            cacheTierRaw ?? (status ? `http-${status}` : 'unreachable'),
          )
        })
    }

    const directUrl = buildDirectTileUrl(level, col, row, f, ext)
    if (!directUrl) {
      loadViaProxy()
      return
    }

    // Fast path: load straight from pzmap.org in the browser,
    // bypassing this server entirely. Some deployments' backend can't reach
    // that host (e.g. a restrictive Kubernetes egress policy) even though
    // the admin's own browser has no such restriction. An <img> tag can't
    // tell a real 404 apart from any other failure, so any failure here
    // just falls back to the proxy path above, which can — still using the
    // same pending-load slot from the increment above (not a new one).
    const directImg = new window.Image()
    directImg.onload = () => {
      if (floorRef.current !== f) { pendingTileLoadsRef.current--; return }
      tileCacheRef.current[key] = directImg
      markRecovered()
      pendingTileLoadsRef.current--
      if (drawRequestRef.current === 0) {
        drawRequestRef.current = requestAnimationFrame(() => { drawRequestRef.current = 0 })
      }
    }
    directImg.onerror = () => {
      if (floorRef.current !== f) { pendingTileLoadsRef.current--; return } // stale, no need to fall back
      loadViaProxy()
    }
    directImg.src = directUrl
  }, [buildDirectTileUrl])

  // A requested level can be within maxLevel yet still have no tile rendered
  // upstream for most of the map -- see GH#109 / conv-gh109-worldmap-black
  // and worldMapTileFallback.ts's header comment. When the exact tile is
  // missing or still loading, draw the matching sub-rectangle of the
  // nearest cached COARSER tile instead of leaving the rect untouched.
  const drawTileWithFallback = useCallback((
    ctx: CanvasRenderingContext2D,
    floor: number,
    level: number,
    col: number,
    row: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ) => {
    const fallback = resolveFallbackTile(
      level,
      col,
      row,
      (l, c, r) => tileCacheRef.current[`${floor}/${l}/${c}_${r}`],
      (l, c, r) => loadDziTile(l, c, r),
      MAX_FALLBACK_LEVELS,
    )
    if (!fallback) return false
    ctx.drawImage(fallback.img, fallback.srcX, fallback.srcY, fallback.srcW, fallback.srcH, dx, dy, dw, dh)
    return true
  }, [loadDziTile])

  // ─── Coordinate transforms (DZI pixel ↔ canvas, game-tile ↔ DZI) ─
  const dziToCanvas = useCallback(
    (dziX: number, dziY: number, s?: number, off?: { x: number; y: number }) => {
      const sc = s ?? scaleRef.current
      const o = off ?? offsetRef.current
      return { x: dziX * sc + o.x, y: dziY * sc + o.y }
    }, []
  )

  const canvasToDzi = useCallback(
    (cx: number, cy: number, s?: number, off?: { x: number; y: number }) => {
      const sc = s ?? scaleRef.current
      const o = off ?? offsetRef.current
      return { x: (cx - o.x) / sc, y: (cy - o.y) / sc }
    }, []
  )

  // Player game-tile → canvas pixel (isometric projection)
  const playerToScreen = useCallback(
    (gx: number, gy: number, s?: number, off?: { x: number; y: number }) => {
      const dzi = gameTileToDzi(gx, gy, mapCfgRef.current)
      return dziToCanvas(dzi.x, dzi.y, s, off)
    }, [dziToCanvas]
  )

  const playerRenderPosition = useCallback(
    (player: MapPlayer, s?: number, off?: { x: number; y: number }) => {
      let drawX = player.x
      let drawY = player.y
      if (!prefersReducedMotion.current && player.animProgress !== undefined && player.animProgress < 1) {
        const progress = easeOutCubic(Math.min(1, player.animProgress))
        drawX = (player.prevX ?? player.x) + (player.x - (player.prevX ?? player.x)) * progress
        drawY = (player.prevY ?? player.y) + (player.y - (player.prevY ?? player.y)) * progress
      }
      return playerToScreen(drawX, drawY, s, off)
    }, [playerToScreen]
  )

  const playerAtScreenPoint = useCallback(
    (mx: number, my: number) => {
      const markerRadius = Math.max(5, Math.min(16, scaleRef.current * 1400))
      let closest: MapPlayer | null = null
      let closestDistance = Number.POSITIVE_INFINITY
      for (const player of playersRef.current) {
        const point = playerRenderPosition(player)
        const distance = Math.hypot(mx - point.x, my - point.y)
        const hitRadius = Math.max(MARKER_HIT_RADIUS, markerRadius + 8)
        if (distance < hitRadius && distance < closestDistance) {
          closest = player
          closestDistance = distance
        }
      }
      return closest
    }, [playerRenderPosition]
  )

  // Canvas pixel → game-tile (inverse isometric)
  const screenToTile = useCallback(
    (cx: number, cy: number, s?: number, off?: { x: number; y: number }) => {
      const dzi = canvasToDzi(cx, cy, s, off)
      return dziToGameTile(dzi.x, dzi.y, mapCfgRef.current)
    }, [canvasToDzi]
  )

  // ─── Data fetching ──────────────────────────────────────
  const fetchPlayerPositions = useCallback(async () => {
    if (!hasActiveServer) {
      setBridgeConnected(false)
      setPlayers([])
      setLoading(false)
      return
    }
    if (!playerFetchGateRef.current.enter()) return

    try {
      const res = await panelBridgeApi.getServerInfo()
      const rawPlayers = res.success && res.data?.players
        ? (Array.isArray(res.data.players) ? res.data.players : Object.values(res.data.players))
        : null
      if (rawPlayers) {
        setBridgeConnected(true)
        // isAlive/isInfected/accessLevel only exist on the wire from bridge
        // v1.7.39 onward -- an older bridge simply omits the keys. Gate on
        // the bridge's own reported version rather than defaulting/passing
        // the (possibly absent) raw value through: an older bridge must
        // read as unknown, never as a specific alive/uninfected/non-admin
        // value we don't actually have.
        const statusFieldsSupported = bridgeSupportsPlayerStatus(bridgeVersionRef.current)
        setPlayers((prev) => {
          const prevMap = new globalThis.Map(prev.map((p) => [p.username || p.displayName, p]))
          return rawPlayers.map((p: RawBridgePlayer) => {
            const key = (p.name || p.username) as string
            const old = prevMap.get(key)
            return {
              username: key,
              displayName: p.displayName || key,
              x: p.x, y: p.y, z: p.z ?? 0,
              health: p.health,
              isAlive: statusFieldsSupported ? p.isAlive : undefined,
              isInfected: statusFieldsSupported ? p.isInfected : undefined,
              accessLevel: statusFieldsSupported ? p.accessLevel : undefined,
              hunger: p.hunger, thirst: p.thirst, fatigue: p.fatigue,
              prevX: old ? old.x : p.x,
              prevY: old ? old.y : p.y,
              animProgress: old && (old.x !== p.x || old.y !== p.y) ? 0 : 1,
            }
          })
        })
      }
    } catch {
      setBridgeConnected(false)
    } finally {
      playerFetchGateRef.current.leave()
      setLoading(false)
    }
  }, [hasActiveServer])

  const checkBridgeStatus = useCallback(async () => {
    if (!hasActiveServer) {
      setBridgeConnected(false)
      setBridgeVersion(null)
      setBridgeLoading(false)
      return
    }

    setBridgeLoading(true)
    try {
      const res = await panelBridgeApi.getStatus()
      setBridgeConnected(res.modConnected === true)
      setBridgeVersion(res.modStatus?.version || null)
    } catch {
      setBridgeConnected(false)
      setBridgeVersion(null)
    } finally {
      setBridgeLoading(false)
    }
  }, [hasActiveServer])

  // Fetch vehicles + safehouses from PanelBridge
  const fetchOverlays = useCallback(async () => {
    if (!mountedRef.current || !hasActiveServer) return
    if (!overlayFetchGateRef.current.enter()) return
    try {
      const [vRes, persistedRes, sRes] = await Promise.allSettled([
        // Vehicle count grows with world uptime/vehicle-mod content, not
        // player count, so it can legitimately exceed the shared 15s
        // default the same way getAllSandboxOptions does -- see
        // BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS's own comment for the
        // client/server timeout race this sizing avoids losing.
        showVehicles ? panelBridgeApi.sendCommand('getVehiclesDetailed', {}, { timeout: BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS }) : Promise.resolve(null),
        showVehicles ? mapApi.vehicles() : Promise.resolve(null),
        panelBridgeApi.sendCommand('getSafehouses'),
      ])
      if (!mountedRef.current) return
      if (showVehicles) {
        const vehicleById = new Map<number, MapVehicle>()
        if (persistedRes.status === 'fulfilled' && persistedRes.value) {
          for (const vehicle of persistedRes.value.vehicles) {
            if (Number.isFinite(vehicle.id) && Number.isFinite(vehicle.x) && Number.isFinite(vehicle.y)) {
              vehicleById.set(vehicle.id, { ...vehicle, persisted: true })
            }
          }
        }
        if (vRes.status === 'fulfilled' && vRes.value && vRes.value.success && vRes.value.data) {
          const vData = vRes.value.data as Record<string, unknown>
          const vList = Array.isArray(vData) ? vData : Array.isArray(vData.vehicles) ? vData.vehicles : []
          for (const vehicle of vList as MapVehicle[]) {
            if (typeof vehicle.id === 'number' && typeof vehicle.x === 'number' && typeof vehicle.y === 'number' && isFinite(vehicle.x) && isFinite(vehicle.y)) {
              vehicleById.set(vehicle.id, vehicle)
            }
          }
        }
        setVehicles([...vehicleById.values()])
      }
      if (sRes.status === 'fulfilled' && sRes.value.success && sRes.value.data) {
        const sData = sRes.value.data as Record<string, unknown>
        const sList = Array.isArray(sData) ? sData : Array.isArray(sData.safehouses) ? sData.safehouses : []
        setSafehouses((sList as MapSafehouse[]).filter(s => typeof s.x === 'number' && typeof s.y === 'number' && isFinite(s.x) && isFinite(s.y)))
      }
    } catch { /* best-effort */
    } finally {
      overlayFetchGateRef.current.leave()
    }
  }, [hasActiveServer, showVehicles])

  // ─── Polling ────────────────────────────────────────────
  useEffect(() => {
    checkBridgeStatus()
    fetchPlayerPositions()
  }, [fetchPlayerPositions, checkBridgeStatus])

  // Fetch overlays on bridge connect and periodically (every 15s)
  useEffect(() => {
    if (!hasActiveServer || !bridgeConnected) return
    fetchOverlays()
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') fetchOverlays()
    }, 15_000)
    return () => clearInterval(interval)
  }, [bridgeConnected, fetchOverlays, hasActiveServer])

  // Deliberately NOT gated on bridgeConnected: fetchPlayerPositions is what
  // sets bridgeConnected in the first place (true on a successful response,
  // false on failure). Gating this interval on bridgeConnected meant that
  // once the mod disconnected, this effect's own guard would tear the
  // interval down and nothing would ever call fetchPlayerPositions again to
  // notice a reconnect -- the "Bridge Offline" badge was stuck until the
  // user reloaded the page or switched servers. Polling through the
  // disconnected state (a cheap failed fetch every 3s) lets it self-heal.
  useEffect(() => {
    if (!hasActiveServer) return
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') fetchPlayerPositions()
    }, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchPlayerPositions, hasActiveServer])

  useEffect(() => { playersRef.current = players }, [players])

  // ─── Canvas rendering ───────────────────────────────────

  // Resolve theme colors once on mount and when theme changes — not per frame
  useEffect(() => {
    canvasColorsRef.current = resolveCanvasColors()
    _carIconCache.clear() // Car icons use theme colors — must re-render
  }, [theme])

  const drawMap = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || canvasSize.width === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const C = canvasColorsRef.current

    // DPR-aware sizing for sharp rendering on high-DPI displays
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(canvasSize.width * dpr)
    canvas.height = Math.floor(canvasSize.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const W = canvasSize.width
    const H = canvasSize.height
    const s = scaleRef.current
    const off = offsetRef.current

    // High-quality image interpolation
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    // Dark background
    ctx.fillStyle = C.background
    ctx.fillRect(0, 0, W, H)

    // ── DZI map tiles ──
    const mc = mapCfgRef.current
    // Clamp to renderedMaxLevel, not maxLevel -- maxLevel is the depth a
    // FULL Deep Zoom pyramid would need for these dimensions, not evidence
    // the tile host actually rendered that deep (see GH#109 /
    // conv-gh109-worldmap-black). The DZI addressing math below (levelScale
    // etc.) still keys off the real maxLevel, since tile level numbering is
    // defined relative to the full theoretical pyramid regardless of how
    // much of it actually exists upstream.
    const level = Math.max(0, Math.min(mc.renderedMaxLevel, Math.round(mc.maxLevel + Math.log2(s))))
    const levelScale = Math.pow(2, mc.maxLevel - level)
    const levelW = Math.ceil(mc.fullWidth / levelScale)
    const levelH = Math.ceil(mc.fullHeight / levelScale)

    // Visible DZI full-res pixel range
    const visMinDziX = -off.x / s
    const visMaxDziX = (W - off.x) / s
    const visMinDziY = -off.y / s
    const visMaxDziY = (H - off.y) / s

    // Convert to level-pixel tile indices. Tile size is per-map-config, not
    // a shared constant — it varies by map build (42.19.0 is 1024, 42.20.0
    // is 2048) as well as between B41 and B42. Using the wrong value here
    // doesn't just misplace tiles, it computes an entirely wrong column/row
    // count — assuming 1024 against a real 2048 tile grid requests up to 2x
    // as many columns/rows as exist, hitting real 404s past the true edge
    // and drawing the ones that do exist at the wrong position.
    const tileSize = mc.tileSize
    const minCol = Math.max(0, Math.floor(visMinDziX / levelScale / tileSize))
    const maxCol = Math.min(Math.ceil(levelW / tileSize) - 1, Math.floor(visMaxDziX / levelScale / tileSize))
    const minRow = Math.max(0, Math.floor(visMinDziY / levelScale / tileSize))
    const maxRow = Math.min(Math.ceil(levelH / tileSize) - 1, Math.floor(visMaxDziY / levelScale / tileSize))

    ctx.save()
    ctx.globalAlpha = 0.9
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        loadDziTile(level, col, row)
        const img = tileCacheRef.current[`${floorRef.current}/${level}/${col}_${row}`]
        // Floor the origin and pad the size by 1px so adjacent tiles
        // slightly overlap instead of leaving a sub-pixel seam (visible as
        // a dark line since tiles draw at globalAlpha 0.9 over a dark bg).
        const dx = Math.floor(col * tileSize * levelScale * s + off.x)
        const dy = Math.floor(row * tileSize * levelScale * s + off.y)
        if (img && img !== 'empty') {
          const dw = Math.ceil(img.naturalWidth * levelScale * s) + 1
          const dh = Math.ceil(img.naturalHeight * levelScale * s) + 1
          ctx.drawImage(img, dx, dy, dw, dh)
        } else {
          // Exact tile missing (confirmed absent) or still loading -- draw a
          // coarser cached tile's matching sub-rectangle instead of nothing.
          const dw = Math.ceil(tileSize * levelScale * s) + 1
          const dh = Math.ceil(tileSize * levelScale * s) + 1
          drawTileWithFallback(ctx, floorRef.current, level, col, row, dx, dy, dw, dh)
        }
      }
    }
    ctx.restore()

    // ── Landmark labels ──
    const markerSize = Math.max(4, Math.min(10, s * 1500))
    const fontSize = Math.max(9, Math.min(14, s * 3000))
    ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = 'center'

    for (const lm of PZ_LANDMARKS) {
      const p = playerToScreen(lm.gx, lm.gy, s, off)
      if (p.x < -100 || p.x > W + 100 || p.y < -50 || p.y > H + 50) continue

      // Glow
      ctx.beginPath()
      ctx.arc(p.x, p.y, markerSize * 2, 0, Math.PI * 2)
      ctx.fillStyle = C.landmarkGlow
      ctx.fill()

      // Diamond
      ctx.beginPath()
      ctx.moveTo(p.x, p.y - markerSize * 0.7)
      ctx.lineTo(p.x + markerSize * 0.7, p.y)
      ctx.lineTo(p.x, p.y + markerSize * 0.7)
      ctx.lineTo(p.x - markerSize * 0.7, p.y)
      ctx.closePath()
      ctx.fillStyle = C.landmarkDiamond
      ctx.fill()

      // Label — the marker-position cull above is generous enough (±100px)
      // that a centered label can still land mostly or entirely off-canvas,
      // leaving only a stray fragment of the name visible (e.g. "gh" of
      // "Muldraugh") on a narrow viewport. Only draw it if it's fully on
      // screen; the marker alone still shows an accurate position.
      const labelWidth = ctx.measureText(lm.name).width
      const labelY = p.y - markerSize - 4
      const labelFits =
        p.x - labelWidth / 2 >= 0 &&
        p.x + labelWidth / 2 <= W &&
        labelY - fontSize >= 0 &&
        labelY <= H
      if (labelFits) {
        ctx.fillStyle = C.landmarkLabel
        ctx.fillText(lm.name, p.x, labelY)
      }
    }

    // ── Safehouse rectangles ──
    if (showSafehouses) {
      const currentSafehouses = safehousesRef.current
      for (const sh of currentSafehouses) {
        // Safehouses have x, y (top-left game-tile) and w, h (size in game-tiles)
        const topLeft = playerToScreen(sh.x, sh.y, s, off)
        const bottomRight = playerToScreen(sh.x + sh.w, sh.y + sh.h, s, off)
        // Isometric: we need all 4 corners for the diamond shape
        const topRight = playerToScreen(sh.x + sh.w, sh.y, s, off)
        const bottomLeft = playerToScreen(sh.x, sh.y + sh.h, s, off)

        // Cull if entirely off-screen
        const allX = [topLeft.x, topRight.x, bottomRight.x, bottomLeft.x]
        const allY = [topLeft.y, topRight.y, bottomRight.y, bottomLeft.y]
        const minPx = Math.min(...allX)
        const maxPx = Math.max(...allX)
        const minPy = Math.min(...allY)
        const maxPy = Math.max(...allY)
        if (maxPx < -50 || minPx > W + 50 || maxPy < -50 || minPy > H + 50) continue

        // Draw isometric diamond
        ctx.beginPath()
        ctx.moveTo(topLeft.x, topLeft.y)
        ctx.lineTo(topRight.x, topRight.y)
        ctx.lineTo(bottomRight.x, bottomRight.y)
        ctx.lineTo(bottomLeft.x, bottomLeft.y)
        ctx.closePath()
        ctx.fillStyle = C.safehouseFill
        ctx.fill()
        ctx.strokeStyle = sh.playerConnected ? C.safehouseStrokeActive : C.safehouseStroke
        ctx.lineWidth = sh.playerConnected ? 2 : 1
        ctx.stroke()

        // Label (only show when zoomed in enough)
        if (s > 0.0008) {
          const centerX = (minPx + maxPx) / 2
          const centerY = (minPy + maxPy) / 2
          const shFontSize = Math.max(8, Math.min(11, s * 2000))
          ctx.font = `600 ${shFontSize}px ui-sans-serif, system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.fillStyle = C.safehouseLabel
          const displayName = sh.title || sh.owner || t('safehouseFallback')
          ctx.fillText(displayName, centerX, centerY - 2)
          if (sh.owner && sh.owner !== displayName) {
            ctx.font = `400 ${shFontSize * 0.85}px ui-sans-serif, system-ui, sans-serif`
            ctx.fillText(sh.owner, centerX, centerY + shFontSize)
          }
        }
      }
    }

    // ── Vehicle markers ──
    const now = performance.now()
    if (showVehicles) {
      const currentVehicles = vehiclesRef.current
      const vSize = Math.max(14, Math.min(36, s * 4200))

      for (const vehicle of currentVehicles) {
        const vp = playerToScreen(vehicle.x, vehicle.y, s, off)
        if (vp.x < -40 || vp.x > W + 40 || vp.y < -40 || vp.y > H + 40) continue

        const isHovered = hoveredVehicle === vehicle.id
        const drawSize = isHovered ? vSize * 1.2 : vSize
        const half = drawSize / 2

        // Color by fuel status
        const vColor = vehicle.fuelPct == null
          ? C.vehicleMarker
          : vehicle.fuelPct > 30
            ? C.vehicleMarker
            : vehicle.fuelPct > 10
              ? C.vehicleFuelWarn
              : C.vehicleFuelCrit
        const color = isHovered ? C.vehicleMarkerHover : vColor

        // Glow on hover
        if (isHovered) {
          ctx.beginPath()
          ctx.arc(vp.x, vp.y, half + 6, 0, Math.PI * 2)
          ctx.fillStyle = C.vehicleGlow
          ctx.fill()
        }

        // Siren halo — cycles blue/red when sirening
        if (vehicle.sirening && !prefersReducedMotion.current) {
          const sirenPhase = (now / 450) % 1
          const sirenR = half + 8 + sirenPhase * 6
          const sirenColor = sirenPhase < 0.5 ? 'hsl(210 95% 60%)' : 'hsl(0 85% 60%)'
          ctx.beginPath()
          ctx.arc(vp.x, vp.y, sirenR, 0, Math.PI * 2)
          ctx.strokeStyle = sirenColor
          ctx.globalAlpha = 0.45 * (1 - sirenPhase)
          ctx.lineWidth = 2
          ctx.stroke()
          ctx.globalAlpha = 1
        }

        // Alarm pulse — amber ring when alarm is active
        if (vehicle.alarmed && !prefersReducedMotion.current) {
          const alarmPhase = (now / 900) % 1
          const alarmR = half + 4 + alarmPhase * 10
          ctx.beginPath()
          ctx.arc(vp.x, vp.y, alarmR, 0, Math.PI * 2)
          ctx.strokeStyle = hslToken('--warning', 0.45 * (1 - alarmPhase))
          ctx.lineWidth = 1.5
          ctx.stroke()
        }

        // Draw cached top-down vehicle icon (padded canvas → center on vp)
        const img = getCarIcon({
          color,
          size: Math.round(drawSize),
          alarmed: !!vehicle.alarmed,
          sirening: !!vehicle.sirening,
          selected: isHovered,
        })
        if (img) {
          ctx.shadowColor = 'rgba(0,0,0,0.55)'
          ctx.shadowBlur = 4
          ctx.shadowOffsetX = 0
          ctx.shadowOffsetY = 2
          // Icon canvas is padded 20% on each side — draw centered
          const drawX = vp.x - img.width / 2
          const drawY = vp.y - img.height / 2
          ctx.drawImage(img, drawX, drawY)
          ctx.shadowColor = 'transparent'
          ctx.shadowBlur = 0
          ctx.shadowOffsetX = 0
          ctx.shadowOffsetY = 0
        }

        // Label on hover or at high zoom
        if ((isHovered || s > 0.003) && s > 0.0008) {
          const vFontSize = Math.max(8, Math.min(11, s * 2000))
          ctx.font = `500 ${vFontSize}px ui-sans-serif, system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.fillStyle = C.vehicleLabel
          const shortName = vehicle.type || vehicle.scriptName?.split('.').pop() || t('vehicleFallback')
          ctx.fillText(shortName, vp.x, vp.y - half - 4)
        }
      }
    }

    // ── Player markers ──
    const currentPlayers = playersRef.current
    const mRadius = Math.max(5, Math.min(16, s * 1400))

    for (const player of currentPlayers) {
      const p = playerRenderPosition(player, s, off)
      if (p.x < -50 || p.x > W + 50 || p.y < -50 || p.y > H + 50) continue

      const isHovered = hoveredPlayer === player.username
      const isSelected = selectedPlayer?.username === player.username
      const isAdmin = player.accessLevel && player.accessLevel !== '' && player.accessLevel !== 'none' && player.accessLevel !== 'user'
      const isDead = player.isAlive === false
      const isInfected = !!player.isInfected && !isDead
      const pinScale = isHovered || isSelected ? 1.2 : 1

      // Top-down survivor token, centred on the real tile position so players
      // read the same way as the top-down vehicle icons.
      const r = mRadius * pinScale
      const color = getPlayerColor(player, 0.95)

      // 1. Ground shadow
      ctx.save()
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.beginPath()
      ctx.ellipse(p.x, p.y + r * 0.8, r * 0.8, r * 0.3, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      // 2. Pulse ring (live players only, subtle)
      if (!prefersReducedMotion.current && !isDead) {
        const seed = player.username.charCodeAt(0) / 26
        const pulsePhase = (now / 1800 + seed) % 1
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 1 + pulsePhase * 9, 0, Math.PI * 2)
        ctx.strokeStyle = getPlayerColor(player, 0.3 * (1 - pulsePhase))
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      // 3. Selection / hover halo
      if (isHovered || isSelected) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 4.5, 0, Math.PI * 2)
        ctx.fillStyle = getPlayerColor(player, 0.18)
        ctx.fill()
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 4.5, 0, Math.PI * 2)
        ctx.strokeStyle = getPlayerColor(player, 0.9)
        ctx.lineWidth = 1.2
        ctx.stroke()
      }

      // 4. Token disc — dark rim keeps the marker legible over any terrain
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 4
      ctx.shadowOffsetY = 1
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fillStyle = C.playerRim
      ctx.fill()
      ctx.restore()

      ctx.beginPath()
      ctx.arc(p.x, p.y, r * 0.84, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()

      // 5. Survivor glyph — head over shoulders, dropped when it would blur
      if (r >= 6.5) {
        ctx.save()
        ctx.fillStyle = C.playerGlyph
        ctx.beginPath()
        ctx.arc(p.x, p.y - r * 0.28, r * 0.3, 0, Math.PI * 2)
        ctx.fill()
        // Shoulders are a dome so the pair never reads as a face
        ctx.beginPath()
        ctx.arc(p.x, p.y + r * 0.58, r * 0.56, Math.PI, 0)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }

      // 6. Infected ring
      if (isInfected) {
        const wobble = prefersReducedMotion.current ? 0 : Math.sin(now / 400) * 0.6
        ctx.save()
        ctx.setLineDash([2.5, 2.5])
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 3.2 + wobble, 0, Math.PI * 2)
        ctx.strokeStyle = C.playerInfectedRing
        ctx.lineWidth = 1.4
        ctx.stroke()
        ctx.restore()
      }

      // 7. Dead overlay
      if (isDead) {
        const xLen = r * 0.44
        ctx.save()
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.lineWidth = 1.6
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(p.x - xLen, p.y - xLen)
        ctx.lineTo(p.x + xLen, p.y + xLen)
        ctx.moveTo(p.x + xLen, p.y - xLen)
        ctx.lineTo(p.x - xLen, p.y + xLen)
        ctx.stroke()
        ctx.restore()
      }

      // 8. Admin ring
      if (isAdmin) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 1.6, 0, Math.PI * 2)
        ctx.strokeStyle = C.adminStar
        ctx.lineWidth = 1.6
        ctx.stroke()
      }

      // 9. Username label above the token
      const labelY = p.y - r - 7
      const labelAlpha = isHovered || isSelected ? 1 : 0.85
      ctx.font = `600 ${Math.max(10, Math.min(13, s * 2500))}px ui-sans-serif, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.save()
      ctx.shadowColor = C.shadowStrong
      ctx.shadowBlur = 3
      ctx.shadowOffsetY = 1
      ctx.fillStyle = hslToken('--foreground', labelAlpha)
      ctx.fillText(player.displayName || player.username, p.x, labelY)
      ctx.restore()

      // 10. Health bar below the token
      if (player.health !== undefined && s > 0.0005 && !isDead) {
        const barW = 26
        const barH = 3
        const barX = p.x - barW / 2
        const barY = p.y + r + 5
        const healthPct = Math.max(0, Math.min(100, player.health)) / 100

        // Backdrop
        ctx.fillStyle = C.healthBarBg
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW, barH, 1.5)
        ctx.fill()

        // Fill
        ctx.fillStyle =
          healthPct > 0.5 ? C.healthGood :
          healthPct > 0.25 ? C.healthWarning :
          C.healthCritical
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW * healthPct, barH, 1.5)
        ctx.fill()

        // Rim
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'
        ctx.lineWidth = 0.6
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW, barH, 1.5)
        ctx.stroke()
      }
    }

    // ── Airdrop markers ──
    const markers = airdropMarkersRef.current
    const nowMs = Date.now()
    for (const marker of markers) {
      const age = nowMs - marker.time
      const fadeAlpha = Math.max(0, 1 - age / 300_000) // fade over 5 min
      if (fadeAlpha <= 0) continue

      const ap = playerToScreen(marker.x, marker.y, s, off)
      if (ap.x < -40 || ap.x > W + 40 || ap.y < -40 || ap.y > H + 40) continue

      const dropSize = Math.max(6, Math.min(16, s * 2000))

      // Pulsing ring (first 30s)
      if (age < 30_000 && !prefersReducedMotion.current) {
        const pulse = ((now / 800) % 1)
        const ringR = dropSize + 8 + pulse * 14
        ctx.beginPath()
        ctx.arc(ap.x, ap.y, ringR, 0, Math.PI * 2)
        ctx.strokeStyle = hslToken('--warning', 0.4 * (1 - pulse) * fadeAlpha)
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // Ground shadow (ellipse below crate)
      ctx.save()
      ctx.globalAlpha = fadeAlpha * 0.25
      ctx.beginPath()
      ctx.ellipse(ap.x, ap.y + dropSize * 1.1, dropSize * 1.2, dropSize * 0.3, 0, 0, Math.PI * 2)
      ctx.fillStyle = C.shadowOpaque
      ctx.fill()
      ctx.restore()

      ctx.save()
      ctx.globalAlpha = fadeAlpha

      const bs = dropSize * 0.7
      const crateTop = ap.y - bs * 0.3
      const crateBottom = ap.y + bs * 1.1
      const crateH = crateBottom - crateTop

      // Crate body (rounded rect)
      ctx.beginPath()
      ctx.roundRect(ap.x - bs, crateTop, bs * 2, crateH, 2)
      ctx.fillStyle = C.crateBody
      ctx.fill()
      ctx.strokeStyle = C.crateBorder
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Crate cross straps
      ctx.beginPath()
      ctx.moveTo(ap.x, crateTop)
      ctx.lineTo(ap.x, crateBottom)
      ctx.moveTo(ap.x - bs, crateTop + crateH * 0.45)
      ctx.lineTo(ap.x + bs, crateTop + crateH * 0.45)
      ctx.strokeStyle = C.crateStraps
      ctx.lineWidth = 1
      ctx.stroke()

      // Parachute lines from crate top corners + center to canopy
      const canopyY = crateTop - dropSize * 1.6
      const canopyW = dropSize * 1.8
      ctx.beginPath()
      ctx.moveTo(ap.x - bs, crateTop)
      ctx.lineTo(ap.x - canopyW, canopyY)
      ctx.moveTo(ap.x + bs, crateTop)
      ctx.lineTo(ap.x + canopyW, canopyY)
      ctx.moveTo(ap.x, crateTop)
      ctx.lineTo(ap.x, canopyY)
      ctx.strokeStyle = hslToken('--foreground', 0.5 * fadeAlpha)
      ctx.lineWidth = 0.8
      ctx.stroke()

      // Parachute canopy (arc)
      ctx.beginPath()
      ctx.moveTo(ap.x - canopyW, canopyY)
      ctx.quadraticCurveTo(ap.x, canopyY - dropSize * 1.2, ap.x + canopyW, canopyY)
      ctx.strokeStyle = hslToken('--warning', 0.85 * fadeAlpha)
      ctx.lineWidth = 2.5
      ctx.stroke()

      // Canopy fill (subtle)
      ctx.beginPath()
      ctx.moveTo(ap.x - canopyW, canopyY)
      ctx.quadraticCurveTo(ap.x, canopyY - dropSize * 1.2, ap.x + canopyW, canopyY)
      ctx.lineTo(ap.x - canopyW, canopyY)
      ctx.closePath()
      ctx.fillStyle = hslToken('--warning', 0.12 * fadeAlpha)
      ctx.fill()

      ctx.restore()

      // Label
      const presetDef = AIRDROP_PRESETS.find((p) => p.id === marker.preset)
      if (presetDef && s > 0.0004) {
        ctx.save()
        const fontSize = Math.max(9, Math.min(12, s * 2200))
        ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.shadowColor = C.shadowDarker
        ctx.shadowBlur = 3
        ctx.shadowOffsetY = 1
        ctx.fillStyle = hslToken('--warning', 0.9 * fadeAlpha)
        ctx.fillText(presetLabel(presetDef.id), ap.x, ap.y - dropSize * 2.2)
        ctx.restore()
      }
    }

    // Empty state
    if (currentPlayers.length === 0) {
      // The floating control rail (top-3 start-3, w-12) permanently overlaps
      // the canvas's start edge -- left in ltr, right in rtl (canvas drawing
      // is raw pixel math, not CSS, so it does not follow the CSS mirror on
      // its own) -- so text centered on the full canvas width can render
      // underneath it on narrow (mobile) viewports. Only nudge away from
      // that edge when a naive center would tuck the text under the rail.
      const railClearance = 72
      const rtl = isRTL(getCurrentLanguage())
      ctx.textAlign = 'center'

      ctx.fillStyle = C.emptyTitle
      ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif'
      const title = t('emptyState.title')
      const titleHalfWidth = ctx.measureText(title).width / 2
      const titleX = rtl
        ? Math.min(W / 2, W - railClearance - titleHalfWidth)
        : Math.max(W / 2, railClearance + titleHalfWidth)
      ctx.fillText(title, titleX, H / 2 - 8)

      ctx.font = '400 11px ui-sans-serif, system-ui, sans-serif'
      ctx.fillStyle = C.emptySubtitle
      const subtitle = t('emptyState.subtitle')
      const subtitleHalfWidth = ctx.measureText(subtitle).width / 2
      const subtitleX = rtl
        ? Math.min(W / 2, W - railClearance - subtitleHalfWidth)
        : Math.max(W / 2, railClearance + subtitleHalfWidth)
      ctx.fillText(subtitle, subtitleX, H / 2 + 10)
    }

    // Crosshair at cursor
    if (cursorWorldPos && !isDragging) {
      const cp = playerToScreen(cursorWorldPos.x, cursorWorldPos.y, s, off)
      ctx.strokeStyle = C.crosshair
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(cp.x - 12, cp.y)
      ctx.lineTo(cp.x + 12, cp.y)
      ctx.moveTo(cp.x, cp.y - 12)
      ctx.lineTo(cp.x, cp.y + 12)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }, [canvasSize, loadDziTile, drawTileWithFallback, playerToScreen, playerRenderPosition, hoveredPlayer, selectedPlayer, cursorWorldPos, isDragging, showVehicles, showSafehouses, hoveredVehicle, t, presetLabel])

  // ─── Animation loop ─────────────────────────────────────
  useEffect(() => {
    let running = true
    const animate = () => {
      if (!running) return
      // Only produce a new array (and thus trigger a re-render) when a
      // player is actually mid-animation — otherwise .map() would return a
      // fresh array every frame forever, re-rendering the whole page at
      // 60fps even while fully idle with no players moving.
      setPlayers((prev) => {
        let changed = false
        const next = prev.map((p) => {
          if (p.animProgress !== undefined && p.animProgress < 1) {
            changed = true
            return { ...p, animProgress: Math.min(1, p.animProgress + 0.06) }
          }
          return p
        })
        return changed ? next : prev
      })
      drawMap()
      animFrameRef.current = requestAnimationFrame(animate)
    }
    animate()
    return () => {
      running = false
      cancelAnimationFrame(animFrameRef.current)
      if (drawRequestRef.current) {
        cancelAnimationFrame(drawRequestRef.current)
        drawRequestRef.current = 0
      }
    }
  }, [drawMap])

  // ─── Canvas resize ──────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          setCanvasSize({ width: Math.floor(width), height: Math.floor(height) })
        }
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  // ─── Set initial view centered on Knox County ───────────
  const hasInitRef = useRef(false)
  useEffect(() => {
    if (hasInitRef.current || canvasSize.width === 0) return
    hasInitRef.current = true
    const c = mapCfgRef.current.defaultCenter
    const s = mapCfgRef.current.defaultScale
    setOffset({
      x: canvasSize.width / 2 - c.x * s,
      y: canvasSize.height / 2 - c.y * s,
    })
  }, [canvasSize])

  // ─── Fit to players ─────────────────────────────────────
  const fitToPlayers = useCallback(() => {
    const W = canvasSize.width
    const H = canvasSize.height
    if (W === 0 || H === 0) return

    if (players.length === 0) {
      // Reset to default Knox County view
      const c = mapCfgRef.current.defaultCenter
      const s = mapCfgRef.current.defaultScale
      setScale(s)
      setOffset({
        x: W / 2 - c.x * s,
        y: H / 2 - c.y * s,
      })
      return
    }

    // Find player bounds in DZI pixel coords
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of players) {
      const dzi = gameTileToDzi(p.x, p.y, mapCfgRef.current)
      minX = Math.min(minX, dzi.x)
      minY = Math.min(minY, dzi.y)
      maxX = Math.max(maxX, dzi.x)
      maxY = Math.max(maxY, dzi.y)
    }

    const pad = 50000 // DZI pixels of padding
    minX -= pad; minY -= pad; maxX += pad; maxY += pad

    const rangeX = maxX - minX
    const rangeY = maxY - minY
    const newScale = Math.min(W / rangeX, H / rangeY, MAX_SCALE)
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2

    setScale(newScale)
    setOffset({ x: W / 2 - centerX * newScale, y: H / 2 - centerY * newScale })
  }, [players, canvasSize])

  // Auto-fit on first player data
  useEffect(() => {
    if (players.length > 0 && !hasFittedRef.current) {
      hasFittedRef.current = true
      fitToPlayers()
    }
  }, [players, fitToPlayers])

  // ─── Wheel zoom (non-passive) ─────────────────────────
  // Attached to the map wrapper (not just canvas) so overlays don't eat the event.
  // Uses refs for immediate read/write to avoid stale-state drift during rapid scrolling.
  useEffect(() => {
    const wrapper = mapWrapperRef.current
    if (!wrapper) return
    const canvas = canvasRef.current

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = (canvas ?? wrapper).getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15

      const prevScale = scaleRef.current
      const prevOff = offsetRef.current
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prevScale * factor))
      const ratio = newScale / prevScale
      const newOffset = {
        x: mx - (mx - prevOff.x) * ratio,
        y: my - (my - prevOff.y) * ratio,
      }

      // Update refs immediately so the next rapid wheel tick reads correct values
      scaleRef.current = newScale
      offsetRef.current = newOffset

      setScale(newScale)
      setOffset(newOffset)
    }

    wrapper.addEventListener('wheel', onWheel, { passive: false })
    return () => wrapper.removeEventListener('wheel', onWheel)
  }, [])

  // ─── Mouse interactions ─────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      pointerDownRef.current = { x: e.clientX, y: e.clientY }
      setIsDragging(true)
      setDragStart({ x: e.clientX, y: e.clientY, offX: offsetRef.current.x, offY: offsetRef.current.y })
      setContextMenu(null)
    }
  }, [])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      if (isDragging) {
        setOffset({
          x: dragStart.offX + (e.clientX - dragStart.x),
          y: dragStart.offY + (e.clientY - dragStart.y),
        })
        return
      }

      // Cursor world position (game tiles)
      const wp = screenToTile(mx, my)
      setCursorWorldPos(wp)

      // Hit test players — the token is centred on the tile position
      let found: string | null = null
      for (const player of playersRef.current) {
        const p = playerRenderPosition(player)
        const hitR = Math.max(MARKER_HIT_RADIUS, Math.max(5, Math.min(16, scaleRef.current * 1400)) + 8)
        if (Math.hypot(mx - p.x, my - p.y) < hitR) {
          found = player.username
          break
        }
      }
      setHoveredPlayer(found)

      // Hit test vehicles (hit radius scales with zoom to match icon size)
      let foundVehicle: number | null = null
      if (showVehicles && !found) {
        const vHitRadius = Math.max(MARKER_HIT_RADIUS, Math.max(14, Math.min(36, scaleRef.current * 4200)) * 0.7)
        for (const v of vehiclesRef.current) {
          const vp = playerToScreen(v.x, v.y)
          const dist = Math.sqrt((mx - vp.x) ** 2 + (my - vp.y) ** 2)
          if (dist < vHitRadius) {
            foundVehicle = v.id
            break
          }
        }
      }
      setHoveredVehicle(foundVehicle)
    },
    [isDragging, dragStart, screenToTile, playerRenderPosition, playerToScreen, showVehicles]
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const start = pointerDownRef.current
      pointerDownRef.current = null
      if (!start) return

      const dx = Math.abs(e.clientX - start.x)
      const dy = Math.abs(e.clientY - start.y)
      setIsDragging(false)

      if (dx >= 3 || dy >= 3) return
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const clickedPlayer = playerAtScreenPoint(e.clientX - rect.left, e.clientY - rect.top)
      setSelectedPlayer(clickedPlayer)
    },
    [playerAtScreenPoint]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const wp = screenToTile(mx, my)

      let clickedPlayer: MapPlayer | undefined
      for (const player of playersRef.current) {
        const p = playerRenderPosition(player)
        const hitR = Math.max(MARKER_HIT_RADIUS, Math.max(5, Math.min(16, scaleRef.current * 1400)) + 4)
        if (Math.hypot(mx - p.x, my - p.y) < hitR) {
          clickedPlayer = player
          break
        }
      }

      let clickedVehicle: MapVehicle | undefined
      if (!clickedPlayer && showVehicles) {
        const vHitRadius = Math.max(MARKER_HIT_RADIUS, Math.max(14, Math.min(36, scaleRef.current * 4200)) * 0.7)
        for (const v of vehiclesRef.current) {
          const vp = playerToScreen(v.x, v.y)
          const dist = Math.sqrt((mx - vp.x) ** 2 + (my - vp.y) ** 2)
          if (dist < vHitRadius) {
            clickedVehicle = v
            break
          }
        }
      }

      setContextMenu({
        screenX: mx,
        screenY: my,
        worldX: wp.x,
        worldY: wp.y,
        player: clickedPlayer,
        vehicle: clickedVehicle,
      })
    },
    [screenToTile, playerRenderPosition, playerToScreen, showVehicles]
  )

  const handleMouseLeave = useCallback(() => {
    pointerDownRef.current = null
    setIsDragging(false)
    setHoveredPlayer(null)
    setHoveredVehicle(null)
    setCursorWorldPos(null)
  }, [])

  // ─── Touch support ─────────────────────────────────────
  const touchRef = useRef<{ startX: number; startY: number; offX: number; offY: number; pinchDist: number | null; moved: boolean; hadPinch: boolean }>({
    startX: 0, startY: 0, offX: 0, offY: 0, pinchDist: null, moved: false, hadPinch: false,
  })

  const getTouchDist = (touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const t = e.touches[0]
      touchRef.current = { startX: t.clientX, startY: t.clientY, offX: offsetRef.current.x, offY: offsetRef.current.y, pinchDist: null, moved: false, hadPinch: false }
      setIsDragging(true)
    } else if (e.touches.length === 2) {
      touchRef.current.pinchDist = getTouchDist(e.touches)
      touchRef.current.moved = true
      touchRef.current.hadPinch = true
    }
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault()
    if (e.touches.length === 2 && touchRef.current.pinchDist !== null) {
      const newDist = getTouchDist(e.touches)
      const factor = newDist / touchRef.current.pinchDist
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
      const prevScale = scaleRef.current
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prevScale * factor))
      const ratio = newScale / prevScale
      const newOffset = { x: cx - (cx - offsetRef.current.x) * ratio, y: cy - (cy - offsetRef.current.y) * ratio }
      scaleRef.current = newScale
      offsetRef.current = newOffset
      setScale(newScale)
      setOffset(newOffset)
      touchRef.current.pinchDist = newDist
    } else if (e.touches.length === 1) {
      const t = e.touches[0]
      const tr = touchRef.current
      if (Math.hypot(t.clientX - tr.startX, t.clientY - tr.startY) >= 3) tr.moved = true
      setOffset({ x: tr.offX + (t.clientX - tr.startX), y: tr.offY + (t.clientY - tr.startY) })
    }
  }, [])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const tr = touchRef.current
    const touch = e.changedTouches[0]
    if (!tr.moved && !tr.hadPinch && touch) {
      const canvas = canvasRef.current
      if (canvas) {
        const rect = canvas.getBoundingClientRect()
        setSelectedPlayer(playerAtScreenPoint(touch.clientX - rect.left, touch.clientY - rect.top))
      }
    }
    setIsDragging(false)
    touchRef.current.pinchDist = null
  }, [playerAtScreenPoint])

  // ─── Zoom controls ─────────────────────────────────────
  const zoomIn = useCallback(() => {
    const cx = canvasSize.width / 2
    const cy = canvasSize.height / 2
    const prev = scaleRef.current
    const next = Math.min(MAX_SCALE, prev * 1.4)
    const ratio = next / prev
    const o = offsetRef.current
    const newOffset = { x: cx - (cx - o.x) * ratio, y: cy - (cy - o.y) * ratio }
    scaleRef.current = next
    offsetRef.current = newOffset
    setScale(next)
    setOffset(newOffset)
  }, [canvasSize])
  const zoomOut = useCallback(() => {
    const cx = canvasSize.width / 2
    const cy = canvasSize.height / 2
    const prev = scaleRef.current
    const next = Math.max(MIN_SCALE, prev / 1.4)
    const ratio = next / prev
    const o = offsetRef.current
    const newOffset = { x: cx - (cx - o.x) * ratio, y: cy - (cy - o.y) * ratio }
    scaleRef.current = next
    offsetRef.current = newOffset
    setScale(next)
    setOffset(newOffset)
  }, [canvasSize])

  // ─── Keyboard controls ─────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const PAN_STEP = 40
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          setOffset((prev) => ({ ...prev, y: prev.y + PAN_STEP }))
          break
        case 'ArrowDown':
          e.preventDefault()
          setOffset((prev) => ({ ...prev, y: prev.y - PAN_STEP }))
          break
        case 'ArrowLeft':
          e.preventDefault()
          setOffset((prev) => ({ ...prev, x: prev.x + PAN_STEP }))
          break
        case 'ArrowRight':
          e.preventDefault()
          setOffset((prev) => ({ ...prev, x: prev.x - PAN_STEP }))
          break
        case '+':
        case '=':
          e.preventDefault()
          zoomIn()
          break
        case '-':
          e.preventDefault()
          zoomOut()
          break
        case 'Escape':
          setContextMenu(null)
          setSelectedPlayer(null)
          break
      }
    },
    [zoomIn, zoomOut]
  )

  // Escape key dismisses context menu globally (even without canvas focus)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
        setSelectedPlayer(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Click outside context menu to dismiss
  useEffect(() => {
    if (!contextMenu) return
    const onClick = (e: MouseEvent) => {
      const menu = mapWrapperRef.current?.querySelector('[role="menu"]')
      if (menu && !menu.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', onClick, true)
    return () => document.removeEventListener('mousedown', onClick, true)
  }, [contextMenu])

  // ─── Actions ────────────────────────────────────────────
  const triggerLightningAt = useCallback(
    async (x: number, y: number) => {
      // Function-level guard, not just the menu item's disabled state --
      // 2026-08-27 bug-hunt floor rule (Angela's Console.tsx Enter-key
      // bypass finding): assert the action is unreachable.
      if (!canWorldEvents) return
      setActionLoading('lightning')
      try {
        const res = await panelBridgeApi.triggerLightning(x, y, true, true, true)
        if (res.success) {
          toast({ title: t('toasts.lightningStrikeTitle'), description: t('toasts.lightningStrikeDesc', { x, y }) })
        }
      } catch {
        toast({ title: t('errorTitle'), description: t('toasts.lightningFailed'), variant: 'destructive' })
      } finally {
        setActionLoading(null)
        setContextMenu(null)
      }
    },
    [toast, canWorldEvents, t]
  )

  const createNoiseAt = useCallback(
    async (x: number, y: number) => {
      if (!canWorldEvents) return
      setActionLoading('noise')
      try {
        const res = await panelBridgeApi.playWorldSound(x, y, 0, 200, 100)
        if (res.success) {
          toast({ title: t('toasts.noiseCreatedTitle'), description: t('toasts.noiseCreatedDesc', { x, y }) })
        }
      } catch {
        toast({ title: t('errorTitle'), description: t('toasts.noiseFailed'), variant: 'destructive' })
      } finally {
        setActionLoading(null)
        setContextMenu(null)
      }
    },
    [toast, canWorldEvents, t]
  )

  const callAirdrop = useCallback(
    async (x: number, y: number, preset: typeof AIRDROP_PRESETS[number]['id']) => {
      if (actionLoadingRef.current) return // prevent double-submit (ref avoids stale closure)
      if (!canRunBridgeCommand) return
      actionLoadingRef.current = 'airdrop'
      setActionLoading('airdrop')
      try {
        // /panel-bridge/command's generic passthrough (bridge.sendCommand())
        // only ever resolves with { success: true, ... } -- an in-game
        // failure rejects the promise instead (see processResult()'s
        // pending.reject branch in services/panelBridge.js) -- so this
        // never sees res.success === false, only the catch below.
        const res = await panelBridgeApi.triggerAirdrop({ x, y, preset, announce: true, attractZombies: true })
        if (!mountedRef.current) return
        const presetDef = AIRDROP_PRESETS.find((p) => p.id === preset)
        const label = presetDef ? presetLabel(presetDef.id) : preset
        const data = res.data as Record<string, unknown> | undefined
        const itemCount = typeof data?.itemCount === 'number' ? data.itemCount : undefined
        const failed = typeof data?.failed === 'number' ? data.failed : 0
        const coords = `${Math.round(x)}, ${Math.round(y)}`
        let desc = itemCount
          ? t('toasts.itemsDropped', { count: itemCount, coords })
          : t('toasts.supplyDrop', { coords })
        if (failed > 0) {
          desc += t('toasts.failedSuffix', { count: failed })
        }
        toast({ title: t('toasts.airdropDeployedTitle', { label }), description: desc })
        setAirdropMarkers((prev) => {
          const next = [...prev, { x, y, preset, time: Date.now() }]
          return next.length > 50 ? next.slice(-50) : next // cap at 50 markers
        })
      } catch (err) {
        if (!mountedRef.current) return
        const msg = getUserErrorMessage(err, t('toasts.areaNotLoaded'))
        toast({ title: t('toasts.airdropFailedTitle'), description: msg, variant: 'destructive' })
      } finally {
        actionLoadingRef.current = null
        if (mountedRef.current) {
          setActionLoading(null)
          setContextMenu(null)
        }
      }
    },
    [toast, t, presetLabel, canRunBridgeCommand]
  )

  // Clean up expired airdrop markers (older than 5 minutes)
  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = Date.now() - 300_000
      setAirdropMarkers((prev) => {
        const filtered = prev.filter((m) => m.time > cutoff)
        return filtered.length === prev.length ? prev : filtered // stable ref if unchanged
      })
    }, 15_000)
    return () => clearInterval(interval)
  }, [])

  // Custom drop — drop one or more items at coords. Reuses the airdrop
  // backend's `items` payload; no new server/Lua route required.
  const callCustomDrop = useCallback(
    async (opts: {
      x: number
      y: number
      items: Array<{ itemType: string; count: number }>
      announce: boolean
      attractZombies: boolean
      soundRadius: number
      silent?: boolean
      label?: string
    }) => {
      if (actionLoadingRef.current) return
      if (!canRunBridgeCommand) return
      const cleaned = opts.items
        .map((it) => ({
          itemType: (it.itemType || '').trim(),
          count: Math.max(1, Math.min(20, Math.floor(Number(it.count) || 1))),
        }))
        .filter((it) => it.itemType.length > 0)
      if (cleaned.length === 0) {
        toast({ title: t('toasts.noItemsTitle'), description: t('toasts.noItemsDesc'), variant: 'destructive' })
        return
      }
      // Module must start with a letter; item name may start with a digit (e.g. 9mmClip, 556Bullets).
      const ID_RE = /^[A-Za-z]\w*\.\w+$/
      const bad = cleaned.find((it) => !ID_RE.test(it.itemType))
      if (bad) {
        toast({
          title: t('toasts.invalidItemTitle'),
          description: t('toasts.invalidItemDesc', { item: bad.itemType }),
          variant: 'destructive',
        })
        return
      }
      if (cleaned.length > 50) {
        toast({ title: t('toasts.tooManyItemsTitle'), description: t('toasts.tooManyItemsDesc'), variant: 'destructive' })
        return
      }
      actionLoadingRef.current = 'drop'
      setActionLoading('drop')
      try {
        // Same shape as callAirdrop above: the generic /panel-bridge/command
        // passthrough only ever resolves on success, so this never sees
        // res.success === false, only the catch below.
        const res = await panelBridgeApi.triggerAirdrop({
          x: opts.x,
          y: opts.y,
          items: cleaned,
          announce: opts.announce,
          attractZombies: opts.attractZombies,
          soundRadius: Math.max(10, Math.min(500, Math.floor(opts.soundRadius))),
        })
        if (!mountedRef.current) return
        const data = res.data as Record<string, unknown> | undefined
        const failed = typeof data?.failed === 'number' ? data.failed : 0
        const totalQty = cleaned.reduce((sum, it) => sum + it.count, 0)
        const coords = `${Math.round(opts.x)}, ${Math.round(opts.y)}`
        const title = opts.label ? t('toasts.droppedTitle', { label: opts.label }) : t('toasts.dropDeployed')
        let desc =
          cleaned.length === 1
            ? t('toasts.singleItemDesc', {
                item: cleaned[0].itemType.replace(/^[^.]+\./, ''),
                qtySuffix: cleaned[0].count > 1 ? t('toasts.qtySuffix', { count: cleaned[0].count }) : '',
                coords,
              })
            : t('toasts.multiItemDesc', { count: cleaned.length, total: totalQty, coords })
        if (failed > 0) desc += t('toasts.failedSuffix', { count: failed })
        if (!opts.silent) toast({ title, description: desc })
        setAirdropMarkers((prev) => {
          const next = [...prev, { x: opts.x, y: opts.y, preset: 'custom', time: Date.now() }]
          return next.length > 50 ? next.slice(-50) : next
        })
        setLastDrop({
          items: cleaned,
          label: opts.label || (cleaned.length === 1
            ? cleaned[0].itemType.replace(/^[^.]+\./, '')
            : t('toasts.itemPackageFallback', { count: cleaned.length })),
        })
      } catch (err) {
        if (!mountedRef.current) return
        const msg = getUserErrorMessage(err, t('toasts.areaNotLoaded'))
        toast({ title: t('toasts.dropFailedTitle'), description: msg, variant: 'destructive' })
      } finally {
        actionLoadingRef.current = null
        if (mountedRef.current) {
          setActionLoading(null)
        }
      }
    },
    [toast, t, canRunBridgeCommand]
  )

  // Teleport an arbitrary online player to the right-clicked coordinate.
  const teleportPlayerTo = useCallback(
    async (username: string, x: number, y: number, z: number) => {
      if (!canRunBridgeCommand) return
      setActionLoading('teleport')
      try {
        // bridge.sendCommand() (services/panelBridge.js) only ever resolves
        // with { success: true, ... } -- an in-game failure rejects the
        // promise instead (see processResult()'s pending.reject branch), so
        // handleResponse() throws into the catch below either way. This
        // never sees res.success === false. It CAN resolve with
        // data.verified !== 'confirmed' though (mod couldn't read back the
        // new position) -- that's not a rejection, so it needs its own check.
        const response = await panelBridgeApi.sendCommand('teleportPlayer', {
          username,
          x: Math.round(x),
          y: Math.round(y),
          z: Math.round(z),
        })
        if (!mountedRef.current) return
        const verifyState = getBridgeVerifiedState('teleportPlayer', response?.data)
        toast(
          verifyState === 'unverifiable'
            ? {
                title: t('toasts.teleportedTitle'),
                description: t('toasts.bridgeUnverifiedDesc', { action: t('toasts.teleportedTitle') }),
                variant: 'default',
              }
            : verifyState === 'old-bridge'
              ? {
                  title: t('toasts.teleportedTitle'),
                  description: t('toasts.bridgeOldBridgeDesc', { action: t('toasts.teleportedTitle') }),
                  variant: 'default',
                }
              : {
                  title: t('toasts.teleportedTitle'),
                  description: t('toasts.teleportedDesc', { username, x: Math.round(x), y: Math.round(y) }),
                },
        )
        fetchPlayerPositions()
      } catch (err) {
        if (!mountedRef.current) return
        const msg = getUserErrorMessage(err, t('toasts.teleportErrorFallback'))
        toast({ title: t('toasts.teleportErrorTitle'), description: msg, variant: 'destructive' })
      } finally {
        if (mountedRef.current) setActionLoading(null)
      }
    },
    [toast, fetchPlayerPositions, t, canRunBridgeCommand]
  )

  // Copy map coordinates to the clipboard. Goes through copyText (not the
  // raw clipboard API directly) so this still works over a plain-HTTP LAN
  // deployment -- navigator.clipboard requires a secure context and is
  // unavailable there; copyText falls back to execCommand.
  const copyCoords = useCallback(
    async (x: number, y: number) => {
      const text = `${Math.round(x)}, ${Math.round(y)}`
      const ok = await copyText(text)
      toast(ok
        ? { title: t('toasts.copiedTitle'), description: text }
        : { title: t('toasts.copyFailedTitle'), description: t('toasts.copyFailedDesc'), variant: 'destructive' })
    },
    [toast, t]
  )

  // Pan to player (from player list click)
  const panToPlayer = useCallback((p: MapPlayer) => {
    const W = canvasSize.width
    const H = canvasSize.height
    if (W === 0) return
    const dzi = gameTileToDzi(p.x, p.y, mapCfgRef.current)
    const viewScale = Math.max(scale, mapCfgRef.current.defaultScale * 10) // zoom in if too far out
    setScale(viewScale)
    setOffset({ x: W / 2 - dzi.x * viewScale, y: H / 2 - dzi.y * viewScale })
    setSelectedPlayer(p)
  }, [canvasSize, scale])

  // ─── Render ─────────────────────────────────────────────
  return (
    <div className="space-y-4 page-transition">
      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        icon={<MapIcon className="w-5 h-5" />}
        actions={
          <div className="flex items-center gap-2">
            <BridgeStatusBadge connected={bridgeConnected} loading={bridgeLoading} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchPlayerPositions()}
              className="gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              {t('refresh')}
            </Button>
          </div>
        }
      />

      <div ref={mapWrapperRef} className="relative rounded-md border border-border/60 overflow-hidden bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.35)]">
        {/* Corner brackets — tactical control-room frame */}
        <span aria-hidden className="pointer-events-none absolute top-0 start-0 z-30 h-3 w-3 border-s-2 border-t-2 border-primary/50" />
        <span aria-hidden className="pointer-events-none absolute top-0 end-0 z-30 h-3 w-3 border-e-2 border-t-2 border-primary/50" />
        <span aria-hidden className="pointer-events-none absolute bottom-0 start-0 z-30 h-3 w-3 border-s-2 border-b-2 border-primary/50" />
        <span aria-hidden className="pointer-events-none absolute bottom-0 end-0 z-30 h-3 w-3 border-e-2 border-b-2 border-primary/50" />

        {/* Control rail — top-left */}
        <div className="absolute top-3 start-3 z-10 w-12 rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg overflow-hidden">
          <div className="flex items-center justify-center gap-1 px-1.5 py-1 border-b border-border/40 bg-muted/40 font-mono text-[9px] uppercase tracking-[0.24em] text-primary/70">
            <span className="text-primary/60">//</span>
            <span>{t('controlRail.ctrlLabel')}</span>
          </div>
          <div className="flex flex-col gap-px p-1">
            <button
              onClick={zoomIn}
              aria-label={t('controlRail.zoomIn')}
              className="group h-9 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t('controlRail.zoomIn')}
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={zoomOut}
              aria-label={t('controlRail.zoomOut')}
              className="group h-9 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t('controlRail.zoomOut')}
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              onClick={fitToPlayers}
              aria-label={t('controlRail.fitToPlayers')}
              className="group h-9 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t('controlRail.fitToPlayers')}
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          </div>

          {/* Floor selector — B42 only (B41 has no multi-level tiles) */}
          {mapCfg.label === 'B42' && (
            <>
              <div className="flex items-center justify-center gap-1 px-1.5 py-1 border-y border-border/40 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] text-muted-foreground/70">
                <span>{t('controlRail.floorHeader')}</span>
              </div>
              <div className="flex flex-col items-center p-1 gap-px">
                <button
                  onClick={() => changeFloor(floor + 1)}
                  disabled={floor >= 29}
                  aria-label={t('controlRail.floorUp')}
                  className="h-6 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-transparent"
                  // eslint-disable-next-line local/no-dead-disabled-title -- pure hint (t('controlRail.floorUp') = "Floor up"), same text as the aria-label, unrelated to why the button disables at the floor cap. Triaged 2026-08-27, no disabled-reason text to lose.
                  title={t('controlRail.floorUp')}
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => changeFloor(0)}
                  aria-label={t('controlRail.currentFloorAria', { floor: floorLabel(floor) })}
                  className={cn(
                    'h-7 w-9 rounded-sm border flex items-center justify-center transition-colors text-[10px] font-mono font-semibold tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                    floor !== 0
                      ? 'bg-accent/20 border-accent/40 text-accent shadow-[inset_0_0_0_1px_rgba(0,0,0,0.2)]'
                      : 'bg-muted/30 border-border/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                  title={t('controlRail.currentFloorTitle', { floor: floorLabel(floor) })}
                >
                  {floor === 0 ? <Layers className="w-3.5 h-3.5" /> : (floor > 0 ? `+${floor}` : floor)}
                </button>
                <button
                  onClick={() => changeFloor(floor - 1)}
                  disabled={floor <= -1}
                  aria-label={t('controlRail.floorDown')}
                  className="h-6 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-transparent"
                  // eslint-disable-next-line local/no-dead-disabled-title -- pure hint (t('controlRail.floorDown') = "Floor down"), same text as the aria-label, unrelated to why the button disables at the floor minimum. Triaged 2026-08-27, no disabled-reason text to lose.
                  title={t('controlRail.floorDown')}
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </div>
            </>
          )}

          <div className="flex items-center justify-center gap-1 px-1.5 py-1 border-y border-border/40 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] text-muted-foreground/70">
            <span>{t('controlRail.layersHeader')}</span>
          </div>
          <div className="flex flex-col gap-px p-1">
            <button
              onClick={() => setShowVehicles((v) => !v)}
              aria-label={t(showVehicles ? 'controlRail.vehiclesHideAria' : 'controlRail.vehiclesShowAria', { count: vehicles.length })}
              aria-pressed={showVehicles}
              className={cn(
                'h-9 w-9 rounded-sm border flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                showVehicles
                  ? 'bg-info/20 border-info/40 text-info'
                  : 'border-transparent text-muted-foreground hover:border-border/50 hover:bg-muted/60 hover:text-foreground'
              )}
              title={t(showVehicles ? 'controlRail.vehiclesHideTitle' : 'controlRail.vehiclesShowTitle', { count: vehicles.length })}
            >
              <Car className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowSafehouses((v) => !v)}
              aria-label={t(showSafehouses ? 'controlRail.safehousesHideAria' : 'controlRail.safehousesShowAria', { count: safehouses.length })}
              aria-pressed={showSafehouses}
              className={cn(
                'h-9 w-9 rounded-sm border flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                showSafehouses
                  ? 'bg-success/20 border-success/40 text-success'
                  : 'border-transparent text-muted-foreground hover:border-border/50 hover:bg-muted/60 hover:text-foreground'
              )}
              title={t(showSafehouses ? 'controlRail.safehousesHideTitle' : 'controlRail.safehousesShowTitle', { count: safehouses.length })}
            >
              <Home className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tile-load failure banner — appears when many *distinct* tiles fail
            with a real error (network outage, firewall blocking
            pzmap.org, upstream tile server down). A genuine
            HTTP 404 (sparse/edge tile, out of map bounds) does NOT count
            toward this — see loadDziTile's 'empty' handling. Without this
            banner the user just sees an indefinite empty map. See issue #6. */}
        {tileLoadFailing && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 max-w-md w-[min(28rem,calc(100%-7rem))]" role="alert">
            <div className="rounded-md border border-warning/60 bg-warning/15 backdrop-blur-md shadow-lg overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-3 py-1 border-b border-warning/30 bg-warning/20 font-mono text-[10px] uppercase tracking-[0.24em] text-warning">
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" />
                  <span>{t('tileFailure.signalLost')}</span>
                </span>
                <span className="text-warning/70">{t('tileFailure.tilesOffline')}</span>
              </div>
              <div className="px-3 py-2 text-xs leading-snug">
                {tileByteDiagnosis ? (
                  // Bytes already in hand were classified directly instead
                  // of guessed at -- a recognised signature earns a
                  // specific, paste-able statement; an unrecognised one
                  // says so plainly with the raw bytes rather than being
                  // forced into a guess. See tileFailureCopyKeys.
                  (() => {
                    const keys = tileFailureCopyKeys(tileByteDiagnosis)
                    return (
                      <>
                        <div className="font-semibold text-foreground">{t(keys.titleKey)}</div>
                        <div className="text-muted-foreground mt-0.5">{t(keys.descKey, keys.descParams)}</div>
                      </>
                    )
                  })()
                ) : tileFailureKind === 'coverage' ? (
                  <>
                    <div className="font-semibold text-foreground">{t('tileFailure.coverageTitle')}</div>
                    <div className="text-muted-foreground mt-0.5">
                      <Trans
                        i18nKey="tileFailure.coverageDesc"
                        t={t}
                        components={{ 1: <span className="font-mono text-warning/90" /> }}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="font-semibold text-foreground">{t('tileFailure.networkTitle')}</div>
                    <div className="text-muted-foreground mt-0.5">
                      <Trans
                        i18nKey="tileFailure.networkDesc"
                        t={t}
                        components={{ 1: <span className="font-mono text-warning/90" /> }}
                      />
                    </div>
                  </>
                )}
                {tileFailureDetail && !tileByteDiagnosis && (
                  // The raw X-Tile-Cache diagnostic code (hit-mem/hit-disk/
                  // miss/http-<status>/unreachable) for network-classified
                  // failures, which never go through the byte-level
                  // classification above (no blob to inspect for those --
                  // see loadViaProxy's .catch() branch). Shown as-is (not
                  // translated) so a screenshot carries the same fact a
                  // devtools Network tab would have shown. Suppressed
                  // whenever the byte diagnosis above is already showing a
                  // more specific, translated statement of the same idea.
                  <div className="mt-1 pt-1 border-t border-warning/20 font-mono text-[10px] text-muted-foreground/70">
                    {t('tileFailure.diagnostic', { detail: tileFailureDetail })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Roster panel — top-right */}
        <div className={cn('absolute top-3 end-3 z-10', rosterCollapsed ? 'w-auto' : 'w-56')}>
          <div className="rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setRosterCollapsed((c) => !c)}
              aria-expanded={!rosterCollapsed}
              aria-label={rosterCollapsed ? t('roster.expandAria') : t('roster.collapseAria')}
              className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 border-b border-border/40 bg-muted/40 font-mono text-[10px] uppercase tracking-[0.22em] text-primary/70 hover:bg-muted/60 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <span className="text-primary/60">//</span>
                <span>{t('roster.label')}</span>
                <span className="text-muted-foreground/50">·</span>
                <span className={cn('flex items-center gap-1', bridgeConnected ? 'text-emerald-400/90' : 'text-muted-foreground/60')}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', bridgeConnected ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground/40')} />
                  {bridgeLoading ? t('roster.loading') : bridgeConnected ? t('roster.live') : t('roster.offline')}
                </span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="text-foreground tabular-nums font-semibold">{players.length}</span>
                {rosterCollapsed ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronUp className="h-3 w-3 shrink-0" />}
              </span>
            </button>
            {!rosterCollapsed && (players.length > 0 ? (
              <div className="max-h-60 overflow-y-auto">
                {players.map((p) => (
                  <button
                    key={p.username}
                    onClick={() => panToPlayer(p)}
                    aria-label={
                      p.health !== undefined
                        ? t('roster.panToAriaWithHealth', { name: p.displayName || p.username, health: Math.round(p.health) })
                        : t('roster.panToAria', { name: p.displayName || p.username })
                    }
                    className={cn(
                      'w-full px-2.5 py-1.5 flex items-center gap-2 text-start text-xs transition-colors border-s-2 border-transparent hover:bg-muted/50',
                      selectedPlayer?.username === p.username && 'bg-muted/50 border-primary/60'
                    )}
                  >
                    <span
                      className="w-2 h-2 rounded-full flex-none ring-1 ring-black/30"
                      style={{ backgroundColor: getPlayerColor(p, 0.9) }}
                    />
                    <span className="truncate flex-1">{p.displayName || p.username}</span>
                    {p.health !== undefined && (
                      <span className={cn(
                        'text-[10px] font-mono tabular-nums',
                        p.health > 50 ? 'text-emerald-400' : p.health > 25 ? 'text-amber-400' : 'text-destructive'
                      )}>
                        {Math.round(p.health)}%
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-3 py-3 flex items-center gap-2 text-[11px] font-mono text-muted-foreground/70">
                <span className={cn('h-1.5 w-1.5 rounded-full', bridgeConnected ? 'bg-muted-foreground/40' : 'bg-destructive/70')} />
                <span>
                  {loading ? t('roster.loading') : bridgeConnected ? t('roster.noPlayersOnline') : t('roster.bridgeOffline')}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* HUD coordinate bar — bottom-left */}
        <div className="absolute bottom-3 start-3 z-10">
          <div className="flex items-stretch rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg font-mono text-[11px] tabular-nums overflow-hidden">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-e border-border/40">
              <Crosshair className={cn('w-3 h-3', cursorWorldPos ? 'text-primary/80' : 'text-muted-foreground/40')} />
              {cursorWorldPos ? (
                <span className="text-foreground">
                  <span className="text-muted-foreground/60">x</span>{cursorWorldPos.x.toString().padStart(5, ' ')}<span className="mx-1 text-muted-foreground/40">·</span><span className="text-muted-foreground/60">y</span>{cursorWorldPos.y.toString().padStart(5, ' ')}
                </span>
              ) : (
                <span className="text-muted-foreground/50">{t('hud.hoverForCoords')}</span>
              )}
            </div>
            <div className="flex items-center gap-1 px-2.5 py-1.5 border-e border-border/40">
              <span className="text-muted-foreground/50 text-[9px] uppercase tracking-[0.22em]">z</span>
              <span className={cn(floor !== 0 ? 'text-accent' : 'text-muted-foreground/70')}>{floorLabel(floor)}</span>
            </div>
            <div className="flex items-center gap-1 px-2.5 py-1.5">
              <span className="text-muted-foreground/50 text-[9px] uppercase tracking-[0.22em]">zm</span>
              <span className="text-muted-foreground/80">{(scale / mapCfg.defaultScale * 100).toFixed(0)}%</span>
            </div>
          </div>
        </div>

        {/* Dossier — bottom-right (selected player). Raised above the HUD
            coordinate bar on narrow viewports so the two fixed-position
            overlays stack instead of colliding; side-by-side once there's
            room (>= sm). */}
        {selectedPlayer && (
          <div className="absolute end-3 z-10 w-60 bottom-14 sm:bottom-3">
            <div className="relative rounded-md border border-border/55 bg-card/90 backdrop-blur-md shadow-lg overflow-hidden">
              <span aria-hidden className="pointer-events-none absolute top-0 start-0 h-2 w-2 border-s-2 border-t-2 border-primary/50" />
              <span aria-hidden className="pointer-events-none absolute top-0 end-0 h-2 w-2 border-e-2 border-t-2 border-primary/50" />
              <span aria-hidden className="pointer-events-none absolute bottom-0 start-0 h-2 w-2 border-s-2 border-b-2 border-primary/50" />
              <span aria-hidden className="pointer-events-none absolute bottom-0 end-0 h-2 w-2 border-e-2 border-b-2 border-primary/50" />
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-border/40 bg-muted/40 font-mono text-[10px] uppercase tracking-[0.22em] text-primary/70">
                <span className="flex items-center gap-1.5">
                  <span className="text-primary/60">//</span>
                  <span>{t('dossier.label')}</span>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="text-emerald-400/90">{t('dossier.targetAcquired')}</span>
                </span>
                <button
                  onClick={() => setSelectedPlayer(null)}
                  className="p-0.5 -m-0.5 rounded text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 transition-colors"
                  aria-label={t('dossier.closeAria')}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="px-3 pt-2.5 pb-2 border-b border-border/30">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full ring-1 ring-black/30 flex-none"
                    style={{ backgroundColor: getPlayerColor(selectedPlayer, 0.9) }}
                  />
                  <span className="text-sm font-semibold truncate">
                    {selectedPlayer.displayName || selectedPlayer.username}
                  </span>
                </div>
              </div>
              <div className="px-3 py-2 text-xs space-y-1.5">
                <div className="flex justify-between items-baseline">
                  <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('dossier.pos')}</span>
                  <span className="font-mono tabular-nums">{Math.round(selectedPlayer.x)}, {Math.round(selectedPlayer.y)}</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('dossier.floor')}</span>
                  <span className="font-mono tabular-nums">{selectedPlayer.z}</span>
                </div>
                {selectedPlayer.health !== undefined && (
                  <div className="flex justify-between items-center">
                    <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('dossier.hp')}</span>
                    <div className="flex items-center gap-1.5">
                      <div className="w-16 h-1.5 rounded-sm bg-muted/60 overflow-hidden ring-1 ring-black/20">
                        <div
                          className="h-full transition-all"
                          style={{
                            width: `${Math.max(0, Math.min(100, selectedPlayer.health))}%`,
                            backgroundColor:
                              selectedPlayer.health > 50 ? 'hsl(var(--success))'
                              : selectedPlayer.health > 25 ? 'hsl(var(--warning))'
                              : 'hsl(var(--destructive))',
                          }}
                        />
                      </div>
                      <span className="font-mono tabular-nums w-8 text-end">{Math.round(selectedPlayer.health)}%</span>
                    </div>
                  </div>
                )}
                {([
                  { key: 'hunger', value: selectedPlayer.hunger, label: t('dossier.hunger') },
                  { key: 'thirst', value: selectedPlayer.thirst, label: t('dossier.thirst') },
                  { key: 'fatigue', value: selectedPlayer.fatigue, label: t('dossier.fatigue') },
                ] as const).map(({ key, value, label }) => value === undefined ? null : (
                  // PZ's stats scale is 0 (fine) to 1 (critical) -- the
                  // inverse of the health bar above, so severity color
                  // thresholds are flipped: full/green only near 0.
                  <div key={key} className="flex justify-between items-center">
                    <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{label}</span>
                    <div className="flex items-center gap-1.5">
                      <div className="w-16 h-1.5 rounded-sm bg-muted/60 overflow-hidden ring-1 ring-black/20">
                        <div
                          className="h-full transition-all"
                          style={{
                            width: `${Math.max(0, Math.min(100, value * 100))}%`,
                            backgroundColor:
                              value < 0.5 ? 'hsl(var(--success))'
                              : value < 0.75 ? 'hsl(var(--warning))'
                              : 'hsl(var(--destructive))',
                          }}
                        />
                      </div>
                      <span className="font-mono tabular-nums w-8 text-end">{Math.round(value * 100)}%</span>
                    </div>
                  </div>
                ))}
                {selectedPlayer.accessLevel && selectedPlayer.accessLevel !== 'none' && selectedPlayer.accessLevel !== 'user' && selectedPlayer.accessLevel !== '' && (
                  <div className="flex justify-between items-baseline">
                    <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('dossier.role')}</span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-400">{selectedPlayer.accessLevel}</span>
                  </div>
                )}
                {selectedPlayer.isInfected && (
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('dossier.status')}</span>
                    <span className="flex items-center gap-1 text-destructive font-mono text-[10px] uppercase tracking-[0.18em]">
                      <Skull className="w-3 h-3" />
                      <span>{t('dossier.infected')}</span>
                    </span>
                  </div>
                )}
              </div>
              <div className="space-y-1 border-t border-border/40 bg-muted/20 px-2 py-1.5">
                <div className="grid grid-cols-2 gap-1">
                <DisabledReason reason={!canGmTools ? t('permissions.noGmToolsBridgeAction') : null}>
                  <Button
                    size="sm" variant="ghost" className="h-7 min-w-0 w-full px-1.5 text-xs gap-1"
                    disabled={actionLoading !== null || !canGmTools}
                    onClick={() => {
                      if (!canGmTools) return
                      setActionLoading('heal-card')
                      panelBridgeApi.sendCommand('healPlayer', { username: selectedPlayer.username })
                        .then(() => { toast({ title: t('dossier.healedTitle'), description: t('dossier.healedDesc', { username: selectedPlayer.username }) }); fetchPlayerPositions() })
                        .catch((err) => toast({ title: t('errorTitle'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                        .finally(() => setActionLoading(null))
                    }}
                  >
                    <Heart className="w-3 h-3" /> {t('dossier.heal')}
                  </Button>
                </DisabledReason>
                <div className="flex min-w-0 items-center gap-1">
                  <DisabledReason reason={!canGmTools ? t('permissions.noGmToolsBridgeAction') : null} className="min-w-0 flex-1">
                    <Button
                      size="sm" variant="ghost" className="h-7 min-w-0 w-full px-1.5 text-xs gap-1"
                      disabled={actionLoading !== null || !canGmTools}
                      onClick={() => {
                        if (!canGmTools) return
                        setActionLoading('god-card')
                        panelBridgeApi.sendCommand('setGodMode', { username: selectedPlayer.username, enabled: true })
                          .then((response) => {
                            const state = getBridgeVerifiedState('setGodMode', response?.data)
                            if (state === 'unverifiable') {
                              toast({ title: t('dossier.godModeEnabled'), description: t('toasts.bridgeUnverifiedDesc', { action: t('dossier.god') }), variant: 'default' })
                            } else if (state === 'old-bridge') {
                              toast({ title: t('dossier.godModeEnabled'), description: t('toasts.bridgeOldBridgeDesc', { action: t('dossier.god') }), variant: 'default' })
                            } else {
                              toast({ title: t('dossier.godModeEnabled') })
                            }
                          })
                          .catch((err) => toast({ title: t('errorTitle'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                          .finally(() => setActionLoading(null))
                      }}
                    >
                      <Shield className="w-3 h-3" /> {t('dossier.god')}
                    </Button>
                  </DisabledReason>
                  <HelpTip label={t('dossier.god')} className="shrink-0">{t('dossier.godTip')}</HelpTip>
                </div>
                </div>
                <Link
                  to={`/players?player=${encodeURIComponent(selectedPlayer.username)}`}
                  onClick={() => setSelectedPlayer(null)}
                  className="flex min-h-7 items-center justify-center gap-1.5 rounded-sm border border-border/50 px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                >
                  <Users className="h-3 w-3" />
                  <span>{t('dossier.openPlayerControls')}</span>
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </div>
          </div>
        )}

        {/* Context menu */}
        {contextMenu && (
          <div
            ref={(el) => {
              // Auto-focus first menu item on open for keyboard accessibility
              if (el) {
                const first = el.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
                first?.focus()
              }
            }}
            role="menu"
            aria-label={t('contextMenu.ariaLabel')}
            className="absolute z-20 min-w-[220px] sm:min-w-[260px] rounded-md bg-card/95 backdrop-blur-md border border-border/55 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.6)] ring-1 ring-primary/10 overflow-y-auto overscroll-contain"
            style={{
              left: contextMenu.screenX,
              top: contextMenu.screenY,
              transform: [
                contextMenu.screenX > (canvasSize.width || 800) / 2 ? 'translateX(-100%)' : '',
                contextMenu.screenY > (canvasSize.height || 600) / 2 ? 'translateY(-100%)' : '',
              ].filter(Boolean).join(' ') || undefined,
              maxHeight: Math.max(
                160,
                (contextMenu.screenY > (canvasSize.height || 600) / 2
                  ? contextMenu.screenY
                  : (canvasSize.height || 600) - contextMenu.screenY) - 12,
              ),
              animation: 'popoverEnter 0.15s ease-out',
            }}
            onKeyDown={(e) => {
              const items = e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
              const focused = document.activeElement as HTMLElement
              const idx = Array.from(items).indexOf(focused as HTMLButtonElement)
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                items[(idx + 1) % items.length]?.focus()
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                items[(idx - 1 + items.length) % items.length]?.focus()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setContextMenu(null)
              }
            }}
          >
            {/* Context header — coordinates + quick copy */}
            <div className="flex items-center justify-between gap-1 px-2 py-1.5 text-[10px] font-mono uppercase tracking-[0.2em] text-primary/70 border-b border-border/40 select-none bg-muted/30">
              <span className="flex items-center gap-1.5">
                <span className="text-primary/60">//</span>
                <span>{t('contextMenu.actionsLabel')}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                <span className="text-foreground tabular-nums normal-case tracking-normal">{Math.round(contextMenu.worldX)}, {Math.round(contextMenu.worldY)}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                <span className="text-muted-foreground/60 normal-case tracking-normal">{floorLabel(floor)}</span>
              </span>
              <button
                type="button"
                title={t('contextMenu.copyCoordsTitle')}
                aria-label={t('contextMenu.copyCoordsTitle')}
                className="p-1 -m-1 rounded hover:bg-muted/60 text-muted-foreground/60 hover:text-foreground transition-colors"
                onClick={(ev) => {
                  ev.stopPropagation()
                  copyCoords(contextMenu.worldX, contextMenu.worldY)
                }}
              >
                <Copy className="w-3 h-3" />
              </button>
            </div>

            {contextMenu.player && (
              <>
                <div className="px-2.5 pt-2 pb-1.5 border-b border-border/30 select-none">
                  <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.24em] text-primary/60 mb-1">
                    <span>›</span>
                    <span>{t('contextMenu.targetLabel')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full ring-1 ring-black/30 flex-none"
                      style={{ backgroundColor: getPlayerColor(contextMenu.player, 0.9) }}
                    />
                    <strong className="text-foreground text-xs truncate">{contextMenu.player.username}</strong>
                  </div>
                </div>
                <ContextMenuItem
                  icon={<Heart className="w-3.5 h-3.5 text-emerald-400" />}
                  label={t('contextMenu.healPlayer')}
                  description={!canGmTools ? t('permissions.noGmToolsBridgeAction') : undefined}
                  tone="success"
                  disabled={!canGmTools}
                  onClick={() => {
                    if (!canGmTools) return
                    panelBridgeApi.sendCommand('healPlayer', { username: contextMenu.player!.username })
                      .then(() => { toast({ title: t('dossier.healedTitle'), description: t('dossier.healedDesc', { username: contextMenu.player!.username }) }); fetchPlayerPositions() })
                      .catch((err) => toast({ title: t('errorTitle'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                    setContextMenu(null)
                  }}
                />
              </>
            )}

            {contextMenu.vehicle && (
              <>
                <div className="px-2.5 pt-2 pb-2 border-b border-border/30 select-none">
                  <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.24em] text-info/70 mb-1.5">
                    <span>›</span>
                    <Car className="w-2.5 h-2.5" />
                    <span>{t('contextMenu.vehicleLabel')}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs">
                    <strong className="text-foreground truncate">{contextMenu.vehicle.type || contextMenu.vehicle.scriptName?.split('.').pop() || t('vehicleFallback')}</strong>
                  </div>
                  <div className="mt-1.5 space-y-1">
                    {contextMenu.vehicle.fuelPct != null && (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/70 w-9">{t('contextMenu.fuel')}</span>
                        <div className="flex-1 h-1.5 rounded-sm bg-muted/60 overflow-hidden ring-1 ring-black/20">
                          <div
                            className={cn("h-full transition-all", contextMenu.vehicle.fuelPct > 30 ? "bg-info/80" : contextMenu.vehicle.fuelPct > 10 ? "bg-amber-400/80" : "bg-destructive/80")}
                            style={{ width: `${Math.round(contextMenu.vehicle.fuelPct)}%` }}
                          />
                        </div>
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/80 w-8 text-end">{Math.round(contextMenu.vehicle.fuelPct)}%</span>
                      </div>
                    )}
                    {contextMenu.vehicle.batteryCharge != null && (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/70 w-9">{t('contextMenu.batt')}</span>
                        <div className="flex-1 h-1.5 rounded-sm bg-muted/60 overflow-hidden ring-1 ring-black/20">
                          <div
                            className={cn("h-full transition-all", contextMenu.vehicle.batteryCharge > 30 ? "bg-info/80" : contextMenu.vehicle.batteryCharge > 10 ? "bg-amber-400/80" : "bg-destructive/80")}
                            style={{ width: `${Math.round(contextMenu.vehicle.batteryCharge)}%` }}
                          />
                        </div>
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/80 w-8 text-end">{Math.round(contextMenu.vehicle.batteryCharge)}%</span>
                      </div>
                    )}
                    {contextMenu.vehicle.fuelPct == null && contextMenu.vehicle.batteryCharge == null && (
                      <div className="font-mono text-[10px] text-muted-foreground/50 italic">{t('contextMenu.noTelemetry')}</div>
                    )}
                  </div>
                </div>
                {contextMenu.vehicle.persisted ? (
                  <div className="px-2.5 py-2 text-[11px] text-muted-foreground/70 border-t border-border/30">
                    {t('contextMenu.loadAreaFirst')}
                  </div>
                ) : (
                  <>
                    <ContextMenuItem
                      icon={<Wrench className="w-3.5 h-3.5 text-info" />}
                      label={t('contextMenu.repairVehicle')}
                      description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : undefined}
                      tone="info"
                      loading={actionLoading === 'vehicle-repair'}
                      disabled={!canRunBridgeCommand}
                      onClick={() => {
                    if (!canRunBridgeCommand) return
                    setActionLoading('vehicle-repair')
                    // Generic /panel-bridge/command passthrough only ever
                    // resolves on success (see teleportPlayerTo above for
                    // why), so .then() never sees res.success === false.
                    panelBridgeApi.sendCommand('vehicleRepair', { vehicleId: contextMenu.vehicle!.id })
                      .then(() => {
                        toast({ title: t('toasts.vehicleRepaired') })
                        fetchOverlays()
                      })
                      .catch((err) => toast({ title: t('toasts.repairFailed'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                      }}
                    />
                    <ContextMenuItem
                  icon={<Fuel className="w-3.5 h-3.5 text-info" />}
                  label={t('contextMenu.fillFuel')}
                  description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : undefined}
                  tone="info"
                  loading={actionLoading === 'vehicle-fuel'}
                  disabled={!canRunBridgeCommand}
                  onClick={() => {
                    if (!canRunBridgeCommand) return
                    setActionLoading('vehicle-fuel')
                    panelBridgeApi.sendCommand('vehicleSetFuel', { vehicleId: contextMenu.vehicle!.id, percent: 100 })
                      .then((response) => {
                        const state = getBridgeVerifiedState('vehicleSetFuel', response?.data)
                        if (state === 'unverifiable') {
                          toast({ title: t('toasts.fuelFilled'), description: t('toasts.bridgeUnverifiedDesc', { action: t('toasts.fuelFilled') }), variant: 'default' })
                        } else if (state === 'old-bridge') {
                          toast({ title: t('toasts.fuelFilled'), description: t('toasts.bridgeOldBridgeDesc', { action: t('toasts.fuelFilled') }), variant: 'default' })
                        } else {
                          toast({ title: t('toasts.fuelFilled') })
                        }
                        fetchOverlays()
                      })
                      .catch((err) => toast({ title: t('toasts.fuelFailed'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                      }}
                    />
                    <ContextMenuItem
                  icon={<Battery className="w-3.5 h-3.5 text-info" />}
                  label={t('contextMenu.chargeBattery')}
                  description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : undefined}
                  tone="info"
                  loading={actionLoading === 'vehicle-battery'}
                  disabled={!canRunBridgeCommand}
                  onClick={() => {
                    if (!canRunBridgeCommand) return
                    setActionLoading('vehicle-battery')
                    panelBridgeApi.sendCommand('vehicleSetBattery', { vehicleId: contextMenu.vehicle!.id, charge: 100 })
                      .then((response) => {
                        const state = getBridgeVerifiedState('vehicleSetBattery', response?.data)
                        if (state === 'unverifiable') {
                          toast({ title: t('toasts.batteryCharged'), description: t('toasts.bridgeUnverifiedDesc', { action: t('toasts.batteryCharged') }), variant: 'default' })
                        } else if (state === 'old-bridge') {
                          toast({ title: t('toasts.batteryCharged'), description: t('toasts.bridgeOldBridgeDesc', { action: t('toasts.batteryCharged') }), variant: 'default' })
                        } else {
                          toast({ title: t('toasts.batteryCharged') })
                        }
                        fetchOverlays()
                      })
                      .catch((err) => toast({ title: t('toasts.batteryFailed'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                      }}
                    />
                    <ContextMenuItem
                  icon={<Trash2 className="w-3.5 h-3.5 text-destructive" />}
                  label={t('contextMenu.removeVehicle')}
                  description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : undefined}
                  tone="danger"
                  disabled={!canRunBridgeCommand}
                  onClick={() => {
                    const v = contextMenu.vehicle!
                    setRemoveVehicleTarget({
                      id: v.id,
                      label: v.type || v.scriptName?.split('.').pop() || t('vehicleFallback'),
                      x: Math.round(v.x),
                      y: Math.round(v.y),
                    })
                    setContextMenu(null)
                      }}
                    />
                    <ContextMenuItem
                  icon={<Zap className="w-3.5 h-3.5 text-amber-400" />}
                  label={t('contextMenu.hotwire')}
                  description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : undefined}
                  tone="warning"
                  loading={actionLoading === 'vehicle-hotwire'}
                  disabled={!canRunBridgeCommand}
                  onClick={() => {
                    if (!canRunBridgeCommand) return
                    setActionLoading('vehicle-hotwire')
                    panelBridgeApi.sendCommand('vehicleHotwire', { vehicleId: contextMenu.vehicle!.id })
                      .then(() => {
                        toast({ title: t('toasts.vehicleHotwired'), description: t('toasts.engineStarted') })
                      })
                      .catch((err) => toast({ title: t('toasts.hotwireFailed'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                      }}
                    />
                  </>
                )}
              </>
            )}

            {/* ── Teleport players to this spot ── */}
            {playersRef.current.length > 0 && (
              <div className="border-t border-border/30">
                <ContextMenuSection label={t('contextMenu.teleportLabel')} icon={<Locate className="w-2.5 h-2.5" />} tone="primary" />
                {playersRef.current.slice(0, 6).map((pl) => {
                  const pColor = pl.isInfected
                    ? 'text-destructive'
                    : pl.accessLevel && pl.accessLevel !== '' && pl.accessLevel !== 'none' && pl.accessLevel !== 'user'
                      ? 'text-amber-400'
                      : 'text-info'
                  return (
                    <ContextMenuItem
                      key={`tp-${pl.username}`}
                      icon={<Users className={cn('w-3.5 h-3.5', pColor)} />}
                      label={pl.displayName || pl.username}
                      description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : t('contextMenu.teleportDesc', {
                        fromX: Math.round(pl.x),
                        fromY: Math.round(pl.y),
                        toX: Math.round(contextMenu.worldX),
                        toY: Math.round(contextMenu.worldY),
                      })}
                      tone="primary"
                      loading={actionLoading === 'teleport'}
                      disabled={!bridgeConnected || !canRunBridgeCommand}
                      onClick={() => {
                        teleportPlayerTo(pl.username, contextMenu.worldX, contextMenu.worldY, floor)
                        setContextMenu(null)
                      }}
                    />
                  )
                })}
                {playersRef.current.length > 6 && (
                  <div className="px-2.5 py-1 font-mono text-[10px] text-muted-foreground/50 italic select-none">
                    {t('contextMenu.moreOnline', { count: playersRef.current.length - 6 })}
                  </div>
                )}
              </div>
            )}

            {/* ── World effects section ── */}
            <div className="border-t border-border/30">
              <ContextMenuSection label={t('contextMenu.effectsLabel')} icon={<Zap className="w-2.5 h-2.5" />} tone="info" />
              <ContextMenuItem
                icon={<CloudLightning className="w-3.5 h-3.5 text-info" />}
                label={t('contextMenu.lightningStrike')}
                description={!canWorldEvents ? t('permissions.noWorldEvents') : t('contextMenu.lightningDesc')}
                tone="info"
                loading={actionLoading === 'lightning'}
                disabled={!canWorldEvents}
                onClick={() => triggerLightningAt(contextMenu.worldX, contextMenu.worldY)}
              />
              <ContextMenuItem
                icon={<Volume2 className="w-3.5 h-3.5 text-amber-400" />}
                label={t('contextMenu.createNoise')}
                description={!canWorldEvents ? t('permissions.noWorldEvents') : t('contextMenu.createNoiseDesc')}
                tone="warning"
                loading={actionLoading === 'noise'}
                disabled={!canWorldEvents}
                onClick={() => createNoiseAt(contextMenu.worldX, contextMenu.worldY)}
              />
              <ContextMenuItem
                icon={<Car className="w-3.5 h-3.5 text-muted-foreground" />}
                label={t('contextMenu.spawnVehicleHere')}
                description={!canGmTools ? t('permissions.noGmTools') : t('contextMenu.spawnVehicleDesc')}
                disabled={!bridgeConnected || !canGmTools}
                onClick={() => {
                  setSpawnDialog({ x: Math.round(contextMenu.worldX), y: Math.round(contextMenu.worldY), z: floor })
                  setSpawnVehicleId('')
                  setContextMenu(null)
                }}
              />
            </div>

            {/* ── Drops section ── */}
            <div className="border-t border-border/30">
              <ContextMenuSection label={t('contextMenu.dropsLabel')} icon={<Package className="w-2.5 h-2.5" />} tone="warning" />
              <ContextMenuItem
                icon={<Package className="w-3.5 h-3.5 text-amber-400" />}
                label={t('contextMenu.customDrop')}
                description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : t('contextMenu.customDropDesc')}
                tone="warning"
                disabled={!bridgeConnected || !canRunBridgeCommand}
                onClick={() => {
                  setDropDialog({ x: Math.round(contextMenu.worldX), y: Math.round(contextMenu.worldY), z: floor })
                  // Seed from last drop if any, otherwise one empty row.
                  if (lastDrop && lastDrop.items.length > 0) {
                    setDropItems(lastDrop.items.map((it) => ({ ...it })))
                  } else {
                    setDropItems([{ itemType: '', count: 1 }])
                  }
                  setActiveTemplateId(null)
                  setSavingTemplate(false)
                  setTemplateNameInput('')
                  setDropAnnounce(true)
                  setDropAttractZombies(true)
                  setDropSoundRadius(150)
                  setContextMenu(null)
                }}
              />
              {lastDrop && (
                <ContextMenuItem
                  icon={<RefreshCw className="w-3.5 h-3.5 text-amber-400/80" />}
                  label={t('contextMenu.repeatLastDrop')}
                  description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : lastDrop.label}
                  tone="warning"
                  loading={actionLoading === 'drop'}
                  disabled={!bridgeConnected || !canRunBridgeCommand}
                  onClick={() => {
                    callCustomDrop({
                      x: contextMenu.worldX,
                      y: contextMenu.worldY,
                      items: lastDrop.items,
                      announce: false, // repeats are silent in-world
                      attractZombies: true,
                      soundRadius: 150,
                      label: lastDrop.label,
                    })
                    setContextMenu(null)
                  }}
                />
              )}
              {dropTemplates.length > 0 && (
                <>
                  <ContextMenuSection label={t('contextMenu.savedPackages')} icon={<Save className="w-2.5 h-2.5" />} tone="muted" />
                  {dropTemplates.slice(0, 8).map((tpl) => (
                    <ContextMenuItem
                      key={tpl.id}
                      icon={<Package className="w-3.5 h-3.5 text-amber-400/70" />}
                      label={tpl.name}
                      description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : t('dropDialog.templateItemCount', { count: tpl.items.length })}
                      tone="warning"
                      loading={actionLoading === 'drop'}
                      disabled={!bridgeConnected || !canRunBridgeCommand}
                      onClick={() => {
                        callCustomDrop({
                          x: contextMenu.worldX,
                          y: contextMenu.worldY,
                          items: tpl.items,
                          announce: true,
                          attractZombies: true,
                          soundRadius: 150,
                          label: tpl.name,
                        })
                        setContextMenu(null)
                      }}
                    />
                  ))}
                </>
              )}
              <ContextMenuSection label={t('contextMenu.presetCrates')} icon={<Package className="w-2.5 h-2.5" />} tone="muted" />
              {AIRDROP_PRESETS.map((preset) => (
                <ContextMenuItem
                  key={preset.id}
                  icon={<preset.icon className="w-3.5 h-3.5 text-amber-400/80" />}
                  label={presetLabel(preset.id)}
                  description={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : presetDesc(preset.id)}
                  tone="warning"
                  loading={actionLoading === 'airdrop'}
                  disabled={!bridgeConnected || !canRunBridgeCommand}
                  onClick={() => callAirdrop(contextMenu.worldX, contextMenu.worldY, preset.id)}
                />
              ))}
              {!bridgeConnected && (
                <div className="mt-1 mx-2 mb-1.5 px-2 py-1.5 rounded-sm border border-destructive/30 bg-destructive/10 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-destructive/85">
                  <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
                  <span>{t('contextMenu.bridgeOfflineDrops')}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Canvas */}
        <div
          ref={containerRef}
          className="w-full"
          style={{ height: 'calc(100vh - 180px)', minHeight: '500px' }}
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            role="img"
            aria-label={t('canvasAria')}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onContextMenu={handleContextMenu}
            onKeyDown={handleKeyDown}
            className={cn('block w-full h-full outline-none focus-visible:ring-2 focus-visible:ring-primary/50', isDragging ? 'cursor-grabbing' : (hoveredPlayer || hoveredVehicle) ? 'cursor-pointer' : 'cursor-grab')}
          />
        </div>
      </div>

      {/* Spawn Vehicle Dialog */}
      <Dialog open={!!spawnDialog} onOpenChange={(open) => { if (!open) setSpawnDialog(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Car className="w-5 h-5" />
              {t('spawnDialog.title')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground font-mono tabular-nums">
                {t('spawnDialog.location', { x: spawnDialog?.x, y: spawnDialog?.y, z: spawnDialog?.z ?? 0 })}
              </span>
              <HelpTip label={t('spawnDialog.title')}>{t('spawnDialog.floorTip')}</HelpTip>
            </div>
            <VehiclePicker
              value={spawnVehicleId}
              onChange={setSpawnVehicleId}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSpawnDialog(null)}>{t('spawnDialog.cancel')}</Button>
            <DisabledReason reason={!canGmTools ? t('permissions.noGmTools') : null}>
            <Button
              disabled={!spawnVehicleId || actionLoading === 'spawn-vehicle' || !canGmTools}
              onClick={() => {
                if (!spawnDialog || !spawnVehicleId) return
                if (!canGmTools) return
                setActionLoading('spawn-vehicle')
                // /players/add-vehicle-at relays rconService.execute()'s
                // result, which resolves { success: false, error } for a
                // failed RCON command rather than throwing -- but
                // handleResponse() throws on ANY 200 body with
                // success: false too (see lib/api.ts), so this still never
                // sees res.success === false, only the catch below.
                playersApi.addVehicleAt(
                  spawnVehicleId,
                  spawnDialog.x,
                  spawnDialog.y,
                  spawnDialog.z,
                )
                  .then(() => {
                    toast({ title: t('toasts.vehicleSpawnedTitle'), description: t('toasts.vehicleSpawnedDesc', { vehicle: spawnVehicleId.split('.').pop(), x: spawnDialog.x, y: spawnDialog.y }) })
                    fetchOverlays()
                    setSpawnDialog(null)
                  })
                  .catch((err) => toast({ title: t('toasts.spawnFailedTitle'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                  .finally(() => setActionLoading(null))
              }}
            >
              {actionLoading === 'spawn-vehicle' ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : <Plus className="w-4 h-4 me-2" />}
              {t('spawnDialog.spawn')}
            </Button>
            </DisabledReason>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Custom Drop Dialog — drops one or more items at the right-clicked coords */}
      <Dialog open={!!dropDialog} onOpenChange={(open) => { if (!open) setDropDialog(null) }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="w-5 h-5 text-warning" />
              {t('dropDialog.title')}
              {activeTemplateId && (() => {
                const tpl = dropTemplates.find((t) => t.id === activeTemplateId)
                return tpl ? (
                  <span className="ms-1 inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-normal text-muted-foreground">
                    <Save className="w-3 h-3" />
                    {tpl.name}
                  </span>
                ) : null
              })()}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Target info */}
            <div className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs font-mono tabular-nums">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Crosshair className="w-3.5 h-3.5" />
                <span className="text-foreground">{dropDialog?.x}, {dropDialog?.y}</span>
                <span className="text-muted-foreground/50">·</span>
                <span>{floorLabel(dropDialog?.z ?? 0)}</span>
              </div>
              <button
                type="button"
                className="text-muted-foreground/60 hover:text-foreground"
                title={t('dropDialog.copyCoordsTitle')}
                onClick={() => dropDialog && copyCoords(dropDialog.x, dropDialog.y)}
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Templates bar */}
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5 me-auto">
                <Save className="w-3.5 h-3.5" />
                {t('dropDialog.packageTemplates')}
              </Label>
              {dropTemplates.length > 0 ? (
                <>
                  <select
                    value={activeTemplateId ?? ''}
                    onChange={(e) => {
                      const id = e.target.value
                      if (!id) {
                        setActiveTemplateId(null)
                        return
                      }
                      const tpl = dropTemplates.find((t) => t.id === id)
                      if (tpl) {
                        setDropItems(tpl.items.map((it) => ({ ...it })))
                        setActiveTemplateId(tpl.id)
                      }
                    }}
                    className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs min-w-[140px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">{t('dropDialog.loadPackagePlaceholder')}</option>
                    {dropTemplates.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {t('dropDialog.templateOptionLabel', { name: tpl.name, count: tpl.items.length })}
                      </option>
                    ))}
                  </select>
                  {activeTemplateId && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 text-destructive hover:text-destructive"
                      title={t('dropDialog.deletePackageTitle')}
                      onClick={() => setDeleteTemplateId(activeTemplateId)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </>
              ) : (
                <span className="text-[11px] text-muted-foreground/60 italic">{t('dropDialog.noPackagesYet')}</span>
              )}
            </div>

            {/* Items list — NO overflow-y-auto here so the ItemPicker dropdown isn't clipped */}
            <div className="rounded-md border border-border/50 bg-muted/10 divide-y divide-border/30">
              {dropItems.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground/60 italic">
                  {t('dropDialog.noItemsRow')}
                </div>
              )}
              {dropItems.map((item, idx) => (
                <div key={idx} className="flex items-end gap-2 px-2 py-2">
                  <div className="flex-1 min-w-0">
                    {idx === 0 && (
                      <Label className="text-[10px] text-muted-foreground/70 mb-1 block">{t('dropDialog.itemLabel')}</Label>
                    )}
                    <ItemPicker
                      value={item.itemType}
                      onChange={(val) => {
                        setDropItems((prev) => prev.map((it, i) => (i === idx ? { ...it, itemType: val } : it)))
                        setActiveTemplateId(null)
                      }}
                      placeholder={t('dropDialog.itemPlaceholder')}
                    />
                  </div>
                  <div className="w-16 shrink-0">
                    {idx === 0 && (
                      <Label className="text-[10px] text-muted-foreground/70 mb-1 block">{t('dropDialog.qtyLabel')}</Label>
                    )}
                    <NumberInput
                      value={item.count}
                      min={1}
                      max={20}
                      className="h-9 text-center tabular-nums"
                      clamp={n => Math.max(1, Math.min(20, n))}
                      onChange={(count) => {
                        if (!Number.isFinite(count)) return
                        setDropItems((prev) => prev.map((it, i) => (i === idx ? { ...it, count } : it)))
                        setActiveTemplateId(null)
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 w-9 p-0 shrink-0 text-muted-foreground/60 hover:text-destructive"
                    title={t('dropDialog.removeItemTitle')}
                    onClick={() => {
                      setDropItems((prev) => (prev.length <= 1 ? [{ itemType: '', count: 1 }] : prev.filter((_, i) => i !== idx)))
                      setActiveTemplateId(null)
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                disabled={dropItems.length >= 50}
                onClick={() => {
                  setDropItems((prev) => [...prev, { itemType: '', count: 1 }])
                  setActiveTemplateId(null)
                }}
              >
                <Plus className="w-3.5 h-3.5 me-1" />
                {t('dropDialog.addItem')}
              </Button>
              <div className="text-[11px] text-muted-foreground/70 tabular-nums">
                {t('dropDialog.validCount', { valid: dropItems.filter((it) => it.itemType.trim()).length, total: dropItems.length })}
              </div>
            </div>

            {/* Save as template */}
            {savingTemplate ? (
              <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                <Save className="w-4 h-4 text-muted-foreground/70 flex-none" />
                <Input
                  autoFocus
                  value={templateNameInput}
                  onChange={(e) => setTemplateNameInput(e.target.value.slice(0, 40))}
                  placeholder={t('dropDialog.savePackagePlaceholder')}
                  className="h-8 flex-1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const name = templateNameInput.trim()
                      if (!name) return
                      const valid = dropItems.filter((it) => it.itemType.trim())
                      if (valid.length === 0) {
                        toast({ title: t('toasts.cannotSaveEmptyPackage'), variant: 'destructive' })
                        return
                      }
                      const id = `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
                      const tpl: DropTemplate = { id, name, items: valid.map((it) => ({ ...it })) }
                      persistDropTemplates([...dropTemplates, tpl].slice(-50))
                      setActiveTemplateId(id)
                      setSavingTemplate(false)
                      setTemplateNameInput('')
                      toast({ title: t('toasts.packageSavedTitle'), description: name })
                    } else if (e.key === 'Escape') {
                      setSavingTemplate(false)
                      setTemplateNameInput('')
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-8"
                  disabled={!templateNameInput.trim()}
                  onClick={() => {
                    const name = templateNameInput.trim()
                    const valid = dropItems.filter((it) => it.itemType.trim())
                    if (!name || valid.length === 0) return
                    const id = `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
                    const tpl: DropTemplate = { id, name, items: valid.map((it) => ({ ...it })) }
                    persistDropTemplates([...dropTemplates, tpl].slice(-50))
                    setActiveTemplateId(id)
                    setSavingTemplate(false)
                    setTemplateNameInput('')
                    toast({ title: t('toasts.packageSavedTitle'), description: name })
                  }}
                >
                  {t('dropDialog.save')}
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => { setSavingTemplate(false); setTemplateNameInput('') }}>
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-full"
                disabled={dropItems.filter((it) => it.itemType.trim()).length === 0}
                onClick={() => { setSavingTemplate(true); setTemplateNameInput('') }}
              >
                <Save className="w-3.5 h-3.5 me-2" />
                {t('dropDialog.saveCurrentAsPackage')}
              </Button>
            )}

            {/* Options */}
            <div className="rounded-md border border-border/50 bg-muted/10 divide-y divide-border/30">
              <label className="flex items-center justify-between gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/20 transition-colors">
                <div className="flex items-start gap-2.5 min-w-0">
                  <Megaphone className="w-4 h-4 text-muted-foreground/70 mt-0.5 flex-none" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t('dropDialog.announceToPlayers')}</div>
                    <div className="text-[11px] text-muted-foreground/70">{t('dropDialog.announceDesc')}</div>
                  </div>
                </div>
                <Switch checked={dropAnnounce} onCheckedChange={setDropAnnounce} />
              </label>
              <label className="flex items-center justify-between gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/20 transition-colors">
                <div className="flex items-start gap-2.5 min-w-0">
                  <BellRing className="w-4 h-4 text-muted-foreground/70 mt-0.5 flex-none" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t('dropDialog.attractZombies')}</div>
                    <div className="text-[11px] text-muted-foreground/70">{t('dropDialog.attractZombiesDesc')}</div>
                  </div>
                </div>
                <Switch checked={dropAttractZombies} onCheckedChange={setDropAttractZombies} />
              </label>
              {dropAttractZombies && (
                <div className="px-3 py-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <Label className="text-xs text-muted-foreground">{t('dropDialog.noiseRadius')}</Label>
                    <span className="text-xs font-mono tabular-nums text-muted-foreground/80">{t('dropDialog.noiseRadiusValue', { radius: dropSoundRadius })}</span>
                  </div>
                  <Input
                    type="range"
                    min={10}
                    max={500}
                    step={10}
                    value={dropSoundRadius}
                    onChange={(e) => setDropSoundRadius(parseInt(e.target.value))}
                    className="h-1.5 accent-warning"
                  />
                  <div className="flex justify-between text-[9px] text-muted-foreground/50 mt-1">
                    <span>{t('dropDialog.whisper')}</span>
                    <span>{t('dropDialog.gunshot')}</span>
                    <span>{t('dropDialog.explosion')}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDropDialog(null)}>{t('dropDialog.cancel')}</Button>
            <DisabledReason reason={!canRunBridgeCommand ? t('permissions.noBridgeCommand') : null}>
            <Button
              disabled={dropItems.filter((it) => it.itemType.trim()).length === 0 || actionLoading === 'drop' || !canRunBridgeCommand}
              onClick={async () => {
                if (!dropDialog) return
                const valid = dropItems.filter((it) => it.itemType.trim())
                if (valid.length === 0) return
                const label = activeTemplateId
                  ? dropTemplates.find((tpl) => tpl.id === activeTemplateId)?.name
                  : valid.length === 1
                    ? valid[0].itemType.replace(/^[^.]+\./, '')
                    : t('toasts.itemPackageFallback', { count: valid.length })
                await callCustomDrop({
                  x: dropDialog.x,
                  y: dropDialog.y,
                  items: valid,
                  announce: dropAnnounce,
                  attractZombies: dropAttractZombies,
                  soundRadius: dropSoundRadius,
                  label,
                })
                if (mountedRef.current) setDropDialog(null)
              }}
            >
              {actionLoading === 'drop'
                ? <Loader2 className="w-4 h-4 me-2 animate-spin" />
                : <Flame className="w-4 h-4 me-2" />}
              {(() => {
                const validCount = dropItems.filter((it) => it.itemType.trim()).length
                const totalQty = dropItems.filter((it) => it.itemType.trim()).reduce((s, it) => s + it.count, 0)
                if (validCount === 0) return t('dropDialog.dropButton')
                if (validCount === 1) return totalQty > 1 ? t('dropDialog.dropButtonQty', { qty: totalQty }) : t('dropDialog.dropButton')
                return t('dropDialog.dropButtonMulti', { count: validCount })
              })()}
            </Button>
            </DisabledReason>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm deletion of a saved drop package */}
      <AlertDialog
        open={!!deleteTemplateId}
        onOpenChange={(open) => { if (!open) setDeleteTemplateId(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deletePackageDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const tpl = dropTemplates.find((d) => d.id === deleteTemplateId)
                if (!tpl) return t('deletePackageDialog.descriptionFallback')
                return t('deletePackageDialog.description', { name: tpl.name, count: tpl.items.length })
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('deletePackageDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const id = deleteTemplateId
                if (!id) return
                const tpl = dropTemplates.find((d) => d.id === id)
                persistDropTemplates(dropTemplates.filter((d) => d.id !== id))
                if (activeTemplateId === id) setActiveTemplateId(null)
                setDeleteTemplateId(null)
                if (tpl) toast({ title: t('toasts.packageDeletedTitle'), description: tpl.name })
              }}
            >
              {t('deletePackageDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm removal of a vehicle from the world — permanent, not undoable. */}
      <AlertDialog
        open={!!removeVehicleTarget}
        onOpenChange={(open) => { if (!open) setRemoveVehicleTarget(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeVehicleDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeVehicleTarget && t('removeVehicleDialog.description', {
                vehicle: removeVehicleTarget.label,
                x: removeVehicleTarget.x,
                y: removeVehicleTarget.y,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading === 'vehicle-remove'}>
              {t('removeVehicleDialog.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={actionLoading === 'vehicle-remove' || !canRunBridgeCommand}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                if (!canRunBridgeCommand) return
                const target = removeVehicleTarget
                if (!target) return
                setActionLoading('vehicle-remove')
                panelBridgeApi.sendCommand('removeVehicle', { vehicleId: target.id })
                  .then(() => {
                    toast({ title: t('toasts.vehicleRemoved') })
                    fetchOverlays()
                  })
                  .catch((err) => toast({ title: t('toasts.removeFailed'), description: getUserErrorMessage(err, t('toasts.unknownError')), variant: 'destructive' }))
                  .finally(() => { setActionLoading(null); setRemoveVehicleTarget(null) })
              }}
            >
              {actionLoading === 'vehicle-remove'
                ? <Loader2 className="w-4 h-4 me-2 animate-spin" />
                : <Trash2 className="w-4 h-4 me-2" />}
              {t('removeVehicleDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────
type ContextMenuTone = 'default' | 'primary' | 'warning' | 'danger' | 'info' | 'success'

function ContextMenuItem({ icon, label, onClick, loading, description, disabled, tone = 'default' }: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  loading?: boolean
  description?: string
  disabled?: boolean
  tone?: ContextMenuTone
}) {
  const toneAccent: Record<ContextMenuTone, string> = {
    default: 'group-hover:border-s-primary/60 group-focus-visible:border-s-primary/60',
    primary: 'group-hover:border-s-primary/70 group-focus-visible:border-s-primary/70',
    warning: 'group-hover:border-s-amber-400/80 group-focus-visible:border-s-amber-400/80',
    danger: 'group-hover:border-s-destructive/80 group-focus-visible:border-s-destructive/80',
    info: 'group-hover:border-s-info/80 group-focus-visible:border-s-info/80',
    success: 'group-hover:border-s-emerald-400/80 group-focus-visible:border-s-emerald-400/80',
  }
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={loading || disabled}
      // eslint-disable-next-line local/no-dead-disabled-title -- description is also rendered as a visible line below (`{description && <span ...>}` a few lines down), so this title is redundant, not a hidden disabled-reason. Adjudicated 2026-08-27 (god chased the "hidden reason" hypothesis and refuted it against the actual JSX).
      title={description}
      className="group relative w-full pe-2 py-1.5 text-xs flex items-stretch gap-2.5 transition-colors duration-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:outline-none"
    >
      <span
        aria-hidden
        className={cn(
          'w-[2px] -my-px shrink-0 border-s-2 border-transparent transition-colors',
          toneAccent[tone]
        )}
      />
      <span className="flex-none w-4 flex items-center justify-center ps-1">
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin text-primary/70" />
          : icon}
      </span>
      <span className="flex flex-col min-w-0 text-start flex-1">
        <span className="truncate text-foreground">{label}</span>
        {description && <span className="text-[10px] text-muted-foreground/60 truncate leading-tight">{description}</span>}
      </span>
    </button>
  )
}

function ContextMenuSection({ label, icon, tone = 'muted' }: {
  label: string
  icon?: React.ReactNode
  tone?: 'muted' | 'primary' | 'warning' | 'info' | 'success' | 'danger'
}) {
  const toneColor: Record<NonNullable<typeof tone>, string> = {
    muted: 'text-muted-foreground/70',
    primary: 'text-primary/75',
    warning: 'text-amber-400/85',
    info: 'text-info/80',
    success: 'text-emerald-400/85',
    danger: 'text-destructive/85',
  }
  return (
    <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 font-mono text-[9px] uppercase tracking-[0.24em] select-none">
      {icon && <span className={cn('flex items-center justify-center', toneColor[tone])}>{icon}</span>}
      <span className={toneColor[tone]}>{label}</span>
      <span className="flex-1 h-px bg-border/40" />
    </div>
  )
}

function getPlayerColor(player: MapPlayer, alpha: number): string {
  // isAlive is undefined (not false) when the bridge doesn't send it --
  // an older bridge or a mid-connect gap must render as the default
  // (unknown) color below, never as muted/"known dead".
  if (player.isAlive === false) return hslToken('--muted-foreground', alpha)
  if (player.isInfected) return hslToken('--destructive', alpha)
  if (player.accessLevel && player.accessLevel !== '' && player.accessLevel !== 'none' && player.accessLevel !== 'user')
    return hslToken('--warning', alpha)
  return hslToken('--info', alpha)
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

// Game tile → DZI full-res pixel (isometric projection)
function gameTileToDzi(gx: number, gy: number, cfg: MapConfig) {
  return {
    x: cfg.isoX0 + (gx - gy) * cfg.isoHalfSqr,
    y: cfg.isoY0 + (gx + gy) * cfg.isoQuarterSqr,
  }
}

// DZI full-res pixel → game tile (inverse isometric)
function dziToGameTile(dziX: number, dziY: number, cfg: MapConfig) {
  const dx = dziX - cfg.isoX0
  const dy = dziY - cfg.isoY0
  return {
    x: dx / (2 * cfg.isoHalfSqr) + dy / (2 * cfg.isoQuarterSqr),
    y: -dx / (2 * cfg.isoHalfSqr) + dy / (2 * cfg.isoQuarterSqr),
  }
}
