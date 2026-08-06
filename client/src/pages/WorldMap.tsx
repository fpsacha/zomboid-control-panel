import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTheme } from '@/contexts/ThemeContext'
import { useSocket } from '@/contexts/SocketContext'
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
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { BridgeStatusBadge } from '@/components/BridgeStatusBadge'
import { VehiclePicker } from '@/components/VehiclePicker'
import { ItemPicker } from '@/components/ItemPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { panelBridgeApi, updateApi, serversApi, mapApi } from '@/lib/api'
import { useToast } from '@/components/ui/use-toast'


import { cn } from '@/lib/utils'

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
  z: number
  scriptName: string
  type: string
  speedKmh: number
  batteryCharge: number
  fuelPct: number
  alarmed: boolean
  sirening: boolean
  trunkLocked: boolean
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

// Airdrop preset definitions
const AIRDROP_PRESETS = [
  { id: 'military',  labelKey: 'presets.military', icon: Swords,          descKey: 'presets.militaryDescription' },
  { id: 'medical',   labelKey: 'presets.medical', icon: Pill,              descKey: 'presets.medicalDescription' },
  { id: 'food',      labelKey: 'presets.food', icon: UtensilsCrossed,     descKey: 'presets.foodDescription' },
  { id: 'building',  labelKey: 'presets.building', icon: Hammer,            descKey: 'presets.buildingDescription' },
  { id: 'weapons',   labelKey: 'presets.weapons', icon: Target,           descKey: 'presets.weaponsDescription' },
  { id: 'tools',     labelKey: 'presets.tools', icon: Wrench,              descKey: 'presets.toolsDescription' },
] as const

// ─── DZI Map Constants ────────────────────────────────────
// Camera: canvasX = dziPixelX * scale + offset.x
// Map tiles served via backend proxy to avoid CORS.

interface MapConfig {
  tileUrl: string
  tileSize: number
  fullWidth: number
  fullHeight: number
  maxLevel: number
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
  isoX0: 518144,
  isoY0: -69648,
  isoHalfSqr: 32,
  isoQuarterSqr: 16,
  defaultCenter: { x: 640000, y: 205000 },
  defaultScale: 0.002,
  label: 'B42',
}

// PZ renders each map build at its own resolution — 42.19.0 is 1157312 wide
// with 1024px tiles, 42.20.0 doubled to 2318656 with 2048px tiles. The
// projection constants above are expressed against MAP_B42.fullWidth, so
// rescale them by whatever the backend reports it is actually proxying.
function b42ConfigFor(info: {
  tileSize: number
  width: number
  height: number
  maxLevel: number
}): MapConfig {
  const k = info.width / MAP_B42.fullWidth
  return {
    ...MAP_B42,
    tileSize: info.tileSize,
    fullWidth: info.width,
    fullHeight: info.height,
    maxLevel: info.maxLevel,
    isoX0: MAP_B42.isoX0 * k,
    isoY0: MAP_B42.isoY0 * k,
    isoHalfSqr: MAP_B42.isoHalfSqr * k,
    isoQuarterSqr: MAP_B42.isoQuarterSqr * k,
    defaultCenter: {
      x: MAP_B42.defaultCenter.x * k,
      y: MAP_B42.defaultCenter.y * k,
    },
    defaultScale: MAP_B42.defaultScale / k,
  }
}

const MAP_B41: MapConfig = {
  tileUrl: '/api/map/b41tiles',
  tileSize: 1024,
  fullWidth: 2285184,
  fullHeight: 990400,
  maxLevel: 22, // ceil(log2(2285184)) = 22
  // Isometric projection from map.projectzomboid.com (multiply=2):
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
]

// ─── Component ────────────────────────────────────────────
export default function WorldMap() {
  const { t } = useTranslation('worldMap');
  
  
  const { theme } = useTheme()
  const socket = useSocket()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapWrapperRef = useRef<HTMLDivElement>(null)
  const animFrameRef = useRef<number>(0)
  const playersRef = useRef<MapPlayer[]>([])
  const drawRequestRef = useRef<number>(0)
  const canvasColorsRef = useRef<CanvasColors>(resolveCanvasColors())

  const [players, setPlayers] = useState<MapPlayer[]>([])
  const [mapCfg, setMapCfg] = useState<MapConfig>(MAP_B42)
  const mapCfgRef = useRef<MapConfig>(MAP_B42)
  const [scale, setScale] = useState(MAP_B42.defaultScale)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [selectedPlayer, setSelectedPlayer] = useState<MapPlayer | null>(null)
  const [bridgeConnected, setBridgeConnected] = useState(false)
  const [bridgeLoading, setBridgeLoading] = useState(false)
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
  const [floor, setFloor] = useState(0)    // PZ floor: 0 = ground, 1+ = upper, -1 = basement
  const floorRef = useRef(0)
  const { toast } = useToast()

  // Floor label helper
  const floorLabel = (f: number) =>
    f === 0 ? t('floorLabels.ground') : f > 0 ? t('floorLabels.floor', { floor: f }) : `B${Math.abs(f)}`

  // Change floor — clears tile cache since tiles differ per floor
  const changeFloor = useCallback((newFloor: number) => {
    const clamped = Math.max(-17, Math.min(29, newFloor))
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
      } else {
        setHasActiveServer(false)
      }
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
      // Compare geometry, not just B41/B42: the initial state is a B42
      // placeholder, so a label check alone would skip applying the
      // resolved build's real dimensions.
      const cur = mapCfgRef.current
      if (
        cur.label === targetCfg.label &&
        cur.tileSize === targetCfg.tileSize &&
        cur.fullWidth === targetCfg.fullWidth
      ) return

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
  // real HTTP 404, not a network/proxy failure) — e.g. a sparse/edge tile
  // near the map boundary. map.projectzomboid.com's own OpenSeadragon
  // viewer just renders these blank; treating them as errors caused a
  // false "tiles offline" banner and visible view jumps on zoom. See the
  // status-aware fetch() below — an <img> tag alone can't distinguish a
  // 404 from any other failure.
  const tileCacheRef = useRef<Record<string, HTMLImageElement | null | 'empty'>>({})

  // Resolved once per session: lets the browser build direct-to-upstream
  // tile URLs (https://map.projectzomboid.com/maps/<dir>/...) instead of
  // always routing through this server's proxy. Some deployments (e.g. a
  // Kubernetes cluster with a restrictive Gateway API egress policy) block
  // outbound access to map.projectzomboid.com for the panel's own pod while
  // the admin's browser has no such restriction. /api/map/resolve has its
  // own cache + hardcoded fallback server-side, so it responds instantly
  // even when the backend itself can't reach map.projectzomboid.com.
  const mapSourceRef = useRef<{ root: string; b42Dir: string; b41Path: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    mapApi.resolve()
      .then((info) => { if (!cancelled) mapSourceRef.current = info })
      .catch(() => { /* direct loading just won't be attempted; proxy fallback still works */ })
    return () => { cancelled = true }
  }, [])

  // Builds the real map.projectzomboid.com URL for a tile, or null if we
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
    return `${src.root}/maps/${src.b42Dir}/base/layer${floor}_files/${level}/${col}_${row}.${ext}`
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

    const markFailed = (reason: 'network' | 'coverage' = 'network') => {
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
          }
        }
      }
    }

    const ext = f === 0 ? 'jpg' : 'webp'
    const proxyFloorParam = f !== 0 ? `?floor=${f}` : ''
    const proxyUrl = `${mapCfgRef.current.tileUrl}/${level}/${col}_${row}.${ext}${proxyFloorParam}`

    // Loads through this server's proxy — the "smart" path that can tell a
    // real 404 (tile genuinely absent; the reference OpenSeadragon viewer
    // on map.projectzomboid.com just renders these blank) apart from an
    // actual connectivity failure, since an <img> tag alone can't see HTTP
    // status codes. Used directly when we haven't resolved a direct
    // upstream URL yet, and as the fallback when a direct browser load
    // fails for an ambiguous reason (which itself might just be a real
    // 404 — routing it through here resolves that ambiguity).
    //
    // pendingTileLoadsRef is decremented at each actual terminal point
    // (not in a blanket .finally()) so the concurrency cap holds the slot
    // for the full lifecycle including image decode.
    const loadViaProxy = () => {
      fetch(proxyUrl)
        .then((res) => {
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
            // Bytes arrived and only the decode failed, so the network is fine.
            markFailed('coverage')
          }
          img.src = objectUrl
        })
        .catch((err) => {
          pendingTileLoadsRef.current--
          const status = (err as { status?: number } | undefined)?.status
          // A readable 4xx means we reached upstream and it has no tile there;
          // 5xx or a rejected fetch means we could not reach it at all.
          markFailed(status && status >= 400 && status < 500 ? 'coverage' : 'network')
        })
    }

    const directUrl = buildDirectTileUrl(level, col, row, f, ext)
    if (!directUrl) {
      loadViaProxy()
      return
    }

    // Fast path: load straight from map.projectzomboid.com in the browser,
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

    try {
      const res = await panelBridgeApi.getServerInfo()
      const rawPlayers = res.success && res.data?.players
        ? (Array.isArray(res.data.players) ? res.data.players : Object.values(res.data.players))
        : null
      if (rawPlayers) {
        setBridgeConnected(true)
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
              isAlive: p.isAlive ?? true,
              isInfected: p.isInfected,
              accessLevel: p.accessLevel,
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
      setLoading(false)
    }
  }, [hasActiveServer])

  const checkBridgeStatus = useCallback(async () => {
    if (!hasActiveServer) {
      setBridgeConnected(false)
      setBridgeLoading(false)
      return
    }

    setBridgeLoading(true)
    try {
      const res = await panelBridgeApi.getStatus()
      setBridgeConnected(res.modConnected === true)
    } catch {
      setBridgeConnected(false)
    } finally {
      setBridgeLoading(false)
    }
  }, [hasActiveServer])

  // Fetch vehicles + safehouses from PanelBridge
  const fetchOverlays = useCallback(async () => {
    if (!mountedRef.current || !hasActiveServer) return
    try {
      const [vRes, sRes] = await Promise.allSettled([
        panelBridgeApi.sendCommand('getVehiclesDetailed'),
        panelBridgeApi.sendCommand('getSafehouses'),
      ])
      if (!mountedRef.current) return
      if (vRes.status === 'fulfilled' && vRes.value.success && vRes.value.data) {
        const vData = vRes.value.data as Record<string, unknown>
        const vList = Array.isArray(vData) ? vData : Array.isArray(vData.vehicles) ? vData.vehicles : []
        setVehicles((vList as MapVehicle[]).filter(v => typeof v.x === 'number' && typeof v.y === 'number' && isFinite(v.x) && isFinite(v.y)))
      }
      if (sRes.status === 'fulfilled' && sRes.value.success && sRes.value.data) {
        const sData = sRes.value.data as Record<string, unknown>
        const sList = Array.isArray(sData) ? sData : Array.isArray(sData.safehouses) ? sData.safehouses : []
        setSafehouses((sList as MapSafehouse[]).filter(s => typeof s.x === 'number' && typeof s.y === 'number' && isFinite(s.x) && isFinite(s.y)))
      }
    } catch { /* best-effort */ }
  }, [hasActiveServer])

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

  useEffect(() => {
    if (!hasActiveServer || !bridgeConnected) return
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') fetchPlayerPositions()
    }, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [bridgeConnected, fetchPlayerPositions, hasActiveServer])

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
    const level = Math.max(0, Math.min(mc.maxLevel, Math.round(mc.maxLevel + Math.log2(s))))
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
        if (img && img !== 'empty') {
          // Floor the origin and pad the size by 1px so adjacent tiles
          // slightly overlap instead of leaving a sub-pixel seam (visible as
          // a dark line since tiles draw at globalAlpha 0.9 over a dark bg).
          const dx = Math.floor(col * tileSize * levelScale * s + off.x)
          const dy = Math.floor(row * tileSize * levelScale * s + off.y)
          const dw = Math.ceil(img.naturalWidth * levelScale * s) + 1
          const dh = Math.ceil(img.naturalHeight * levelScale * s) + 1
          ctx.drawImage(img, dx, dy, dw, dh)
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

      // Label
      ctx.fillStyle = C.landmarkLabel
      ctx.fillText(lm.name, p.x, p.y - markerSize - 4)
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
          const displayName = sh.title || sh.owner || 'Safehouse'
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
          const shortName = vehicle.type || vehicle.scriptName?.split('.').pop() || t('vehicle')
          ctx.fillText(shortName, vp.x, vp.y - half - 4)
        }
      }
    }

    // ── Player markers ──
    const currentPlayers = playersRef.current
    const mRadius = Math.max(5, Math.min(9, s * 1400))

    for (const player of currentPlayers) {
      // Interpolate position (skip if reduced motion)
      let drawX = player.x
      let drawY = player.y
      if (!prefersReducedMotion.current && player.animProgress !== undefined && player.animProgress < 1) {
        const t = easeOutCubic(Math.min(1, player.animProgress))
        drawX = (player.prevX ?? player.x) + (player.x - (player.prevX ?? player.x)) * t
        drawY = (player.prevY ?? player.y) + (player.y - (player.prevY ?? player.y)) * t
      }

      const p = playerToScreen(drawX, drawY, s, off)
      if (p.x < -50 || p.x > W + 50 || p.y < -50 || p.y > H + 50) continue

      const isHovered = hoveredPlayer === player.username
      const isSelected = selectedPlayer?.username === player.username
      const isAdmin = player.accessLevel && player.accessLevel !== '' && player.accessLevel !== 'none' && player.accessLevel !== 'user'
      const isDead = player.isAlive === false
      const isInfected = !!player.isInfected && !isDead
      const pinScale = isHovered || isSelected ? 1.2 : 1

      // Pin geometry — a refined teardrop anchored at p.x, p.y
      const tipX = p.x
      const tipY = p.y
      const headR = mRadius * 1.0 * pinScale
      const headCenterY = tipY - headR * 2.2 // head sits above the tip
      const shoulderOffset = headR * 0.85 // where the teardrop sides meet the head
      const color = getPlayerColor(player, 0.95)

      // 1. Ground shadow — soft ellipse beneath the tip to anchor the pin
      ctx.save()
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.beginPath()
      ctx.ellipse(tipX, tipY + 1.5, headR * 0.9, headR * 0.3, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      // 2. Pulse ring (live players only, subtle)
      if (!prefersReducedMotion.current && !isDead) {
        const seed = player.username.charCodeAt(0) / 26
        const pulsePhase = (now / 1800 + seed) % 1
        const pulseRadius = headR + 2 + pulsePhase * 10
        const pulseAlpha = 0.32 * (1 - pulsePhase)
        ctx.beginPath()
        ctx.arc(p.x, headCenterY, pulseRadius, 0, Math.PI * 2)
        ctx.strokeStyle = getPlayerColor(player, pulseAlpha)
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      // 3. Selection / hover halo
      if (isHovered || isSelected) {
        ctx.beginPath()
        ctx.arc(p.x, headCenterY, headR + 4, 0, Math.PI * 2)
        ctx.fillStyle = getPlayerColor(player, 0.2)
        ctx.fill()
      }

      // 4. Teardrop body — rounded top, tapered to tip
      // Using bezier curves from tip → left shoulder → top arc → right shoulder → back to tip.
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.45)'
      ctx.shadowBlur = 4
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 2

      ctx.beginPath()
      ctx.moveTo(tipX, tipY)
      // Left side: tip → left shoulder
      ctx.quadraticCurveTo(
        tipX - shoulderOffset * 0.4,
        tipY - headR * 1.2,
        tipX - shoulderOffset,
        headCenterY + headR * 0.55
      )
      // Top arc: left shoulder → over the head → right shoulder
      ctx.arc(p.x, headCenterY, headR * 1.05, Math.PI + 0.55, -0.55, false)
      // Right side: right shoulder → tip
      ctx.quadraticCurveTo(
        tipX + shoulderOffset * 0.4,
        tipY - headR * 1.2,
        tipX,
        tipY
      )
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
      ctx.restore()

      // 5. Pin outline for crispness
      ctx.beginPath()
      ctx.moveTo(tipX, tipY)
      ctx.quadraticCurveTo(
        tipX - shoulderOffset * 0.4,
        tipY - headR * 1.2,
        tipX - shoulderOffset,
        headCenterY + headR * 0.55
      )
      ctx.arc(p.x, headCenterY, headR * 1.05, Math.PI + 0.55, -0.55, false)
      ctx.quadraticCurveTo(
        tipX + shoulderOffset * 0.4,
        tipY - headR * 1.2,
        tipX,
        tipY
      )
      ctx.closePath()
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'
      ctx.lineWidth = 1.2
      ctx.stroke()

      // 6. Inner head disc — a darker plate that the 'face' sits on
      ctx.beginPath()
      ctx.arc(p.x, headCenterY, headR * 0.72, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0,0,0,0.32)'
      ctx.fill()

      // 7. Face disc — solid head in the player color, with rim
      ctx.beginPath()
      ctx.arc(p.x, headCenterY, headR * 0.58, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'
      ctx.lineWidth = 0.8
      ctx.stroke()

      // 8. Specular highlight on the head
      ctx.beginPath()
      ctx.arc(p.x - headR * 0.22, headCenterY - headR * 0.25, headR * 0.2, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.38)'
      ctx.fill()

      // 9. Infected indicator — a jagged viral ring
      if (isInfected && !prefersReducedMotion.current) {
        const spikes = 8
        const innerR = headR * 0.85
        const outerR = headR * 1.15 + Math.sin(now / 400) * 0.8
        ctx.beginPath()
        for (let i = 0; i < spikes * 2; i++) {
          const angle = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2
          const r = i % 2 === 0 ? outerR : innerR
          const x = p.x + Math.cos(angle) * r
          const y = headCenterY + Math.sin(angle) * r
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.closePath()
        ctx.strokeStyle = hslToken('--destructive', 0.75)
        ctx.lineWidth = 1.2
        ctx.stroke()
      }

      // 10. Dead overlay — X through the pin
      if (isDead) {
        const xLen = headR * 0.65
        ctx.save()
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.lineWidth = 1.5
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(p.x - xLen, headCenterY - xLen)
        ctx.lineTo(p.x + xLen, headCenterY + xLen)
        ctx.moveTo(p.x + xLen, headCenterY - xLen)
        ctx.lineTo(p.x - xLen, headCenterY + xLen)
        ctx.stroke()
        ctx.restore()
      }

      // 11. Admin crown badge — replaces the old 5-point star
      if (isAdmin) {
        const bx = p.x + headR * 0.95
        const by = headCenterY - headR * 0.85
        ctx.save()
        ctx.fillStyle = C.adminStar
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'
        ctx.lineWidth = 0.8
        // Tiny crown shape (3 points + base)
        const crownH = headR * 0.55
        const crownW = headR * 0.8
        ctx.beginPath()
        ctx.moveTo(bx - crownW / 2, by + crownH / 2)
        ctx.lineTo(bx - crownW / 2, by - crownH / 4)
        ctx.lineTo(bx - crownW / 4, by + crownH / 4)
        ctx.lineTo(bx, by - crownH / 2)
        ctx.lineTo(bx + crownW / 4, by + crownH / 4)
        ctx.lineTo(bx + crownW / 2, by - crownH / 4)
        ctx.lineTo(bx + crownW / 2, by + crownH / 2)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
        ctx.restore()
      }

      // 12. Username label above the pin
      const labelY = headCenterY - headR - 6
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

      // 13. Health bar below the tip
      if (player.health !== undefined && s > 0.0005 && !isDead) {
        const barW = 26
        const barH = 3
        const barX = p.x - barW / 2
        const barY = tipY + 4
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
        ctx.fillText(t(presetDef.labelKey), ap.x, ap.y - dropSize * 2.2)
        ctx.restore()
      }
    }

    // Empty state
    if (currentPlayers.length === 0) {
      ctx.textAlign = 'center'
      ctx.fillStyle = C.emptyTitle
      ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif'
      ctx.fillText(t('canvas.noPlayers'), W / 2, H / 2 - 8)
      ctx.font = '400 11px ui-sans-serif, system-ui, sans-serif'
      ctx.fillStyle = C.emptySubtitle
      ctx.fillText(t('canvas.bridgePositions'), W / 2, H / 2 + 10)
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
  }, [canvasSize, loadDziTile, playerToScreen, hoveredPlayer, selectedPlayer, cursorWorldPos, isDragging, showVehicles, showSafehouses, hoveredVehicle, t])

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

      // Hit test players — pin anchors at tip, head sits ~18px above; accept either.
      let found: string | null = null
      for (const player of playersRef.current) {
        const p = playerToScreen(player.x, player.y)
        const pinR = Math.max(5, Math.min(9, scaleRef.current * 1400))
        const headY = p.y - pinR * 2.2
        // Closest vertical point on pin (tip or head)
        const dxTip = mx - p.x, dyTip = my - p.y
        const dxHead = mx - p.x, dyHead = my - headY
        const distTip = Math.sqrt(dxTip * dxTip + dyTip * dyTip)
        const distHead = Math.sqrt(dxHead * dxHead + dyHead * dyHead)
        if (distTip < MARKER_HIT_RADIUS || distHead < MARKER_HIT_RADIUS) {
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
    [isDragging, dragStart, screenToTile, playerToScreen, showVehicles]
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging) {
        const dx = Math.abs(e.clientX - dragStart.x)
        const dy = Math.abs(e.clientY - dragStart.y)
        setIsDragging(false)

        if (dx < 3 && dy < 3) {
          const canvas = canvasRef.current
          if (!canvas) return
          const rect = canvas.getBoundingClientRect()
          const mx = e.clientX - rect.left
          const my = e.clientY - rect.top

          for (const player of playersRef.current) {
            const p = playerToScreen(player.x, player.y)
            const dist = Math.sqrt((mx - p.x) ** 2 + (my - p.y) ** 2)
            if (dist < MARKER_HIT_RADIUS) {
              setSelectedPlayer(player)
              return
            }
          }
          setSelectedPlayer(null)
        }
      }
    },
    [isDragging, dragStart, playerToScreen]
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
        const p = playerToScreen(player.x, player.y)
        const pinR = Math.max(5, Math.min(9, scaleRef.current * 1400))
        const headY = p.y - pinR * 2.2
        const distTip = Math.sqrt((mx - p.x) ** 2 + (my - p.y) ** 2)
        const distHead = Math.sqrt((mx - p.x) ** 2 + (my - headY) ** 2)
        if (distTip < MARKER_HIT_RADIUS || distHead < MARKER_HIT_RADIUS) {
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
    [screenToTile, playerToScreen, showVehicles]
  )

  const handleMouseLeave = useCallback(() => {
    setIsDragging(false)
    setHoveredPlayer(null)
    setHoveredVehicle(null)
    setCursorWorldPos(null)
  }, [])

  // ─── Touch support ─────────────────────────────────────
  const touchRef = useRef<{ startX: number; startY: number; offX: number; offY: number; pinchDist: number | null }>({
    startX: 0, startY: 0, offX: 0, offY: 0, pinchDist: null,
  })

  const getTouchDist = (touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const t = e.touches[0]
      touchRef.current = { startX: t.clientX, startY: t.clientY, offX: offsetRef.current.x, offY: offsetRef.current.y, pinchDist: null }
      setIsDragging(true)
    } else if (e.touches.length === 2) {
      touchRef.current.pinchDist = getTouchDist(e.touches)
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
      setOffset({ x: tr.offX + (t.clientX - tr.startX), y: tr.offY + (t.clientY - tr.startY) })
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false)
    touchRef.current.pinchDist = null
  }, [])

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
      setActionLoading('lightning')
      try {
        const res = await panelBridgeApi.triggerLightning(x, y, true, true, true)
        if (res.success) {
          toast({ title: t('toast.lightningStrike'), description: t('toast.struckAt', { x, y }) })
        }
      } catch {
        toast({ title: t('toast.error'), description: t('errors.lightningFailed'), variant: 'destructive' })
      } finally {
        setActionLoading(null)
        setContextMenu(null)
      }
    },
    [t, toast]
  )

  const createNoiseAt = useCallback(
    async (x: number, y: number) => {
      setActionLoading('noise')
      try {
        const res = await panelBridgeApi.playWorldSound(x, y, 0, 200, 100)
        if (res.success) {
          toast({ title: t('toast.noiseCreated'), description: t('toast.soundAttracting', { x, y }) })
        }
      } catch {
        toast({ title: t('toast.error'), description: t('errors.noiseFailed'), variant: 'destructive' })
      } finally {
        setActionLoading(null)
        setContextMenu(null)
      }
    },
    [t, toast]
  )

  const callAirdrop = useCallback(
    async (x: number, y: number, preset: typeof AIRDROP_PRESETS[number]['id']) => {
      if (actionLoadingRef.current) return // prevent double-submit (ref avoids stale closure)
      actionLoadingRef.current = 'airdrop'
      setActionLoading('airdrop')
      try {
        const res = await panelBridgeApi.triggerAirdrop({ x, y, preset, announce: true, attractZombies: true })
        if (!mountedRef.current) return
        if (res.success) {
          const presetDef = AIRDROP_PRESETS.find((p) => p.id === preset)
          const label = presetDef ? t(presetDef.labelKey) : preset
          const data = res.data as Record<string, unknown> | undefined
          const itemCount = typeof data?.itemCount === 'number' ? data.itemCount : undefined
          const failed = typeof data?.failed === 'number' ? data.failed : 0
          const coords = `${Math.round(x)}, ${Math.round(y)}`
          let desc = itemCount
            ? t('toast.itemsDroppedAt', { count: itemCount, coords })
            : t('toast.supplyDropAt', { coords })
          if (failed > 0) {
            desc += ` (${t('toast.failedCount', { count: failed })})`
          }
          toast({ title: t('toast.airdropDeployed', { label }), description: desc })
          setAirdropMarkers((prev) => {
            const next = [...prev, { x, y, preset, time: Date.now() }]
            return next.length > 50 ? next.slice(-50) : next // cap at 50 markers
          })
        } else {
          toast({ title: t('toast.airdropFailed'), description: res.error || t('errors.areaNotLoaded'), variant: 'destructive' })
        }
      } catch (err) {
        if (!mountedRef.current) return
        const msg = err instanceof Error ? err.message : t('errors.airdropCallFailed')
        toast({ title: t('toast.airdropError'), description: msg, variant: 'destructive' })
      } finally {
        actionLoadingRef.current = null
        if (mountedRef.current) {
          setActionLoading(null)
          setContextMenu(null)
        }
      }
    },
    [t, toast]
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
      const cleaned = opts.items
        .map((it) => ({
          itemType: (it.itemType || '').trim(),
          count: Math.max(1, Math.min(20, Math.floor(Number(it.count) || 1))),
        }))
        .filter((it) => it.itemType.length > 0)
      if (cleaned.length === 0) {
        toast({ title: t('toast.noItems'), description: t('errors.addItem'), variant: 'destructive' })
        return
      }
      // Module must start with a letter; item name may start with a digit (e.g. 9mmClip, 556Bullets).
      const ID_RE = /^[A-Za-z]\w*\.\w+$/
      const bad = cleaned.find((it) => !ID_RE.test(it.itemType))
      if (bad) {
        toast({
          title: t('toast.invalidItem'),
          description: t('errors.invalidItem', { item: bad.itemType }),
          variant: 'destructive',
        })
        return
      }
      if (cleaned.length > 50) {
        toast({ title: t('toast.tooManyItems'), description: t('errors.tooManyItems'), variant: 'destructive' })
        return
      }
      actionLoadingRef.current = 'drop'
      setActionLoading('drop')
      try {
        const res = await panelBridgeApi.triggerAirdrop({
          x: opts.x,
          y: opts.y,
          items: cleaned,
          announce: opts.announce,
          attractZombies: opts.attractZombies,
          soundRadius: Math.max(10, Math.min(500, Math.floor(opts.soundRadius))),
        })
        if (!mountedRef.current) return
        if (res.success) {
          const data = res.data as Record<string, unknown> | undefined
          const failed = typeof data?.failed === 'number' ? data.failed : 0
          const totalQty = cleaned.reduce((sum, it) => sum + it.count, 0)
          const coords = `${Math.round(opts.x)}, ${Math.round(opts.y)}`
          const title = opts.label ? t('toast.dropLabel', { label: opts.label }) : t('toast.dropDeployed')
          let desc =
            cleaned.length === 1
              ? t('toast.singleItemAt', { item: cleaned[0].itemType.replace(/^[^.]+\./, ''), quantity: cleaned[0].count > 1 ? ` × ${cleaned[0].count}` : '', coords })
              : t('toast.multipleItemsAt', { count: cleaned.length, total: totalQty, coords })
          if (failed > 0) desc += ` (${t('toast.failedCount', { count: failed })})`
          if (!opts.silent) toast({ title, description: desc })
          setAirdropMarkers((prev) => {
            const next = [...prev, { x: opts.x, y: opts.y, preset: 'custom', time: Date.now() }]
            return next.length > 50 ? next.slice(-50) : next
          })
          setLastDrop({
            items: cleaned,
            label: opts.label || (cleaned.length === 1
              ? cleaned[0].itemType.replace(/^[^.]+\./, '')
              : `${cleaned.length}-item package`),
          })
        } else {
          toast({ title: t('toast.dropFailed'), description: res.error || t('errors.areaNotLoaded'), variant: 'destructive' })
        }
      } catch (err) {
        if (!mountedRef.current) return
        const msg = err instanceof Error ? err.message : t('errors.dropItemFailed')
        toast({ title: t('toast.dropError'), description: msg, variant: 'destructive' })
      } finally {
        actionLoadingRef.current = null
        if (mountedRef.current) {
          setActionLoading(null)
        }
      }
    },
    [t, toast]
  )

  // Teleport an arbitrary online player to the right-clicked coordinate.
  const teleportPlayerTo = useCallback(
    async (username: string, x: number, y: number, z: number) => {
      setActionLoading('teleport')
      try {
        const res = await panelBridgeApi.sendCommand('teleportPlayer', {
          username,
          x: Math.round(x),
          y: Math.round(y),
          z: Math.round(z),
        })
        if (!mountedRef.current) return
        if (res.success) {
          toast({
            title: t('toast.playerTeleported'),
            description: t('toast.playerTeleportedDescription', { username, x: Math.round(x), y: Math.round(y) }),
          })
          fetchPlayerPositions()
        } else {
          toast({
            title: t('toast.teleportFailed'),
            description: res.error || t('errors.destinationNotLoaded'),
            variant: 'destructive',
          })
        }
      } catch (err) {
        if (!mountedRef.current) return
        const msg = err instanceof Error ? err.message : t('errors.teleport')
        toast({ title: t('toast.teleportError'), description: msg, variant: 'destructive' })
      } finally {
        if (mountedRef.current) setActionLoading(null)
      }
    },
    [fetchPlayerPositions, t, toast]
  )

  // Copy map coordinates to the clipboard.
  const copyCoords = useCallback(
    async (x: number, y: number) => {
      const text = `${Math.round(x)}, ${Math.round(y)}`
      try {
        await navigator.clipboard.writeText(text)
        toast({ title: t('toast.copied'), description: text })
      } catch {
        toast({ title: t('toast.copyFailed'), description: t('errors.clipboardUnavailable'), variant: 'destructive' })
      }
    },
    [t, toast]
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
        title={t("title")}
        description={t("description")}
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
              {t('actions.refresh')}
            </Button>
          </div>
        }
      />

      <div ref={mapWrapperRef} className="relative rounded-md border border-border/60 overflow-hidden bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.35)]">
        {/* Corner brackets — tactical control-room frame */}
        <span aria-hidden className="pointer-events-none absolute top-0 left-0 z-30 h-3 w-3 border-l-2 border-t-2 border-primary/50" />
        <span aria-hidden className="pointer-events-none absolute top-0 right-0 z-30 h-3 w-3 border-r-2 border-t-2 border-primary/50" />
        <span aria-hidden className="pointer-events-none absolute bottom-0 left-0 z-30 h-3 w-3 border-l-2 border-b-2 border-primary/50" />
        <span aria-hidden className="pointer-events-none absolute bottom-0 right-0 z-30 h-3 w-3 border-r-2 border-b-2 border-primary/50" />

        {/* Control rail — top-left */}
        <div className="absolute top-3 left-3 z-10 w-12 rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg overflow-hidden">
          <div className="flex items-center justify-center gap-1 px-1.5 py-1 border-b border-border/40 bg-muted/40 font-mono text-[9px] uppercase tracking-[0.24em] text-primary/70">
            <span className="text-primary/60">//</span>
            <span>{t('ctrl')}</span>
          </div>
          <div className="flex flex-col gap-px p-1">
            <button
              onClick={zoomIn}
              aria-label={t('controls.zoomIn')}
              className="group h-9 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t('controls.zoomIn')}
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={zoomOut}
              aria-label={t('controls.zoomOut')}
              className="group h-9 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t('controls.zoomOut')}
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              onClick={fitToPlayers}
              aria-label={t('controls.fitToPlayers')}
              className="group h-9 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              title={t('controls.fitToPlayers')}
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          </div>

          {/* Floor selector — B42 only (B41 has no multi-level tiles) */}
          {mapCfg.label === 'B42' && (
            <>
              <div className="flex items-center justify-center gap-1 px-1.5 py-1 border-y border-border/40 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] text-muted-foreground/70">
                <span>{t('floor')}</span>
              </div>
              <div className="flex flex-col items-center p-1 gap-px">
                <button
                  onClick={() => changeFloor(floor + 1)}
                  disabled={floor >= 29}
                  aria-label={t('controls.floorUp')}
                  className="h-6 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-transparent"
                  title={t('controls.floorUp')}
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => changeFloor(0)}
                  aria-label={t('controls.currentFloor', { floor: floorLabel(floor) })}
                  className={cn(
                    'h-7 w-9 rounded-sm border flex items-center justify-center transition-colors text-[10px] font-mono font-semibold tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                    floor !== 0
                      ? 'bg-accent/20 border-accent/40 text-accent shadow-[inset_0_0_0_1px_rgba(0,0,0,0.2)]'
                      : 'bg-muted/30 border-border/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                  title={t('controls.resetFloor', { floor: floorLabel(floor) })}
                >
                  {floor === 0 ? <Layers className="w-3.5 h-3.5" /> : (floor > 0 ? `+${floor}` : floor)}
                </button>
                <button
                  onClick={() => changeFloor(floor - 1)}
                  disabled={floor <= -17}
                  aria-label={t('controls.floorDown')}
                  className="h-6 w-9 rounded-sm border border-transparent hover:border-border/50 hover:bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-transparent"
                  title={t('controls.floorDown')}
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </div>
            </>
          )}

          <div className="flex items-center justify-center gap-1 px-1.5 py-1 border-y border-border/40 bg-muted/30 font-mono text-[9px] uppercase tracking-[0.24em] text-muted-foreground/70">
            <span>{t('layers')}</span>
          </div>
          <div className="flex flex-col gap-px p-1">
            <button
              onClick={() => setShowVehicles((v) => !v)}
              aria-label={showVehicles ? t('controls.hideVehicles', { count: vehicles.length }) : t('controls.showVehicles', { count: vehicles.length })}
              aria-pressed={showVehicles}
              className={cn(
                'h-9 w-9 rounded-sm border flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                showVehicles
                  ? 'bg-info/20 border-info/40 text-info'
                  : 'border-transparent text-muted-foreground hover:border-border/50 hover:bg-muted/60 hover:text-foreground'
              )}
              title={t('controls.vehiclesTitle', { action: showVehicles ? t('controls.hide') : t('controls.show'), count: vehicles.length })}
            >
              <Car className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowSafehouses((v) => !v)}
              aria-label={showSafehouses ? t('controls.hideSafehouses', { count: safehouses.length }) : t('controls.showSafehouses', { count: safehouses.length })}
              aria-pressed={showSafehouses}
              className={cn(
                'h-9 w-9 rounded-sm border flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                showSafehouses
                  ? 'bg-success/20 border-success/40 text-success'
                  : 'border-transparent text-muted-foreground hover:border-border/50 hover:bg-muted/60 hover:text-foreground'
              )}
              title={t('controls.safehousesTitle', { action: showSafehouses ? t('controls.hide') : t('controls.show'), count: safehouses.length })}
            >
              <Home className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tile-load failure banner — appears when many *distinct* tiles fail
            with a real error (network outage, firewall blocking
            map.projectzomboid.com, upstream tile server down). A genuine
            HTTP 404 (sparse/edge tile, out of map bounds) does NOT count
            toward this — see loadDziTile's 'empty' handling. Without this
            banner the user just sees an indefinite empty map. See issue #6. */}
        {tileLoadFailing && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 max-w-md w-[min(28rem,calc(100%-7rem))]" role="alert">
            <div className="rounded-md border border-warning/60 bg-warning/15 backdrop-blur-md shadow-lg overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-3 py-1 border-b border-warning/30 bg-warning/20 font-mono text-[10px] uppercase tracking-[0.24em] text-warning">
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" />
                  <span>{t('status.signalLost')}</span>
                </span>
                <span className="text-warning/70">{t('tilesOffline')}</span>
              </div>
              <div className="px-3 py-2 text-xs leading-snug">
                {tileFailureKind === 'coverage' ? (
                  <>
                    <div className="font-semibold text-foreground">{t('noMapTilesAtThisZoom')}</div>
                    <div className="text-muted-foreground mt-0.5">
                      <span className="font-mono text-warning/90">map.projectzomboid.com</span> {t('mapErrors.coverageDescription')}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="font-semibold text-foreground">{t('mapTilesArentLoading')}</div>
                    <div className="text-muted-foreground mt-0.5">
                      {t('mapErrors.networkPrefix')} <span className="font-mono text-warning/90">map.projectzomboid.com</span>. {t('mapErrors.networkSuffix')}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Roster panel — top-right */}
        <div className="absolute top-3 right-3 z-10 w-56">
          <div className="rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-border/40 bg-muted/40 font-mono text-[10px] uppercase tracking-[0.22em] text-primary/70">
              <span className="flex items-center gap-1.5">
                <span className="text-primary/60">//</span>
                <span>{t('roster')}</span>
                <span className="text-muted-foreground/50">·</span>
                <span className={cn('flex items-center gap-1', bridgeConnected ? 'text-emerald-400/90' : 'text-muted-foreground/60')}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', bridgeConnected ? 'bg-emerald-400 animate-pulse' : 'bg-muted-foreground/40')} />
                  {bridgeConnected ? t('status.live') : t('status.offline')}
                </span>
              </span>
              <span className="text-foreground tabular-nums font-semibold">{players.length}</span>
            </div>
            {players.length > 0 ? (
              <div className="max-h-60 overflow-y-auto">
                {players.map((p) => (
                  <button
                    key={p.username}
                    onClick={() => panToPlayer(p)}
                    aria-label={t('controls.panToPlayer', { name: p.displayName || p.username, health: p.health !== undefined ? `, ${t('hp')} ${Math.round(p.health)}%` : '' })}
                    className={cn(
                      'w-full px-2.5 py-1.5 flex items-center gap-2 text-left text-xs transition-colors border-l-2 border-transparent hover:bg-muted/50',
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
                  {loading ? t('status.loading') : bridgeConnected ? t('status.noPlayersOnline') : t('status.bridgeOffline')}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* HUD coordinate bar — bottom-left */}
        <div className="absolute bottom-3 left-3 z-10">
          <div className="flex items-stretch rounded-md border border-border/55 bg-card/85 backdrop-blur-md shadow-lg font-mono text-[11px] tabular-nums overflow-hidden">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-r border-border/40">
              <Crosshair className={cn('w-3 h-3', cursorWorldPos ? 'text-primary/80' : 'text-muted-foreground/40')} />
              {cursorWorldPos ? (
                <span className="text-foreground">
                  <span className="text-muted-foreground/60">x</span>{cursorWorldPos.x.toString().padStart(5, ' ')}<span className="mx-1 text-muted-foreground/40">·</span><span className="text-muted-foreground/60">y</span>{cursorWorldPos.y.toString().padStart(5, ' ')}
                </span>
              ) : (
                <span className="text-muted-foreground/50">{t('hoverForCoords')}</span>
              )}
            </div>
            <div className="flex items-center gap-1 px-2.5 py-1.5 border-r border-border/40">
              <span className="text-muted-foreground/50 text-[9px] uppercase tracking-[0.22em]">z</span>
              <span className={cn(floor !== 0 ? 'text-accent' : 'text-muted-foreground/70')}>{floorLabel(floor)}</span>
            </div>
            <div className="flex items-center gap-1 px-2.5 py-1.5">
              <span className="text-muted-foreground/50 text-[9px] uppercase tracking-[0.22em]">{t('zm')}</span>
              <span className="text-muted-foreground/80">{(scale / mapCfg.defaultScale * 100).toFixed(0)}%</span>
            </div>
          </div>
        </div>

        {/* Dossier — bottom-right (selected player) */}
        {selectedPlayer && (
          <div className="absolute bottom-3 right-3 z-10 w-60">
            <div className="relative rounded-md border border-border/55 bg-card/90 backdrop-blur-md shadow-lg overflow-hidden">
              <span aria-hidden className="pointer-events-none absolute top-0 left-0 h-2 w-2 border-l-2 border-t-2 border-primary/50" />
              <span aria-hidden className="pointer-events-none absolute top-0 right-0 h-2 w-2 border-r-2 border-t-2 border-primary/50" />
              <span aria-hidden className="pointer-events-none absolute bottom-0 left-0 h-2 w-2 border-l-2 border-b-2 border-primary/50" />
              <span aria-hidden className="pointer-events-none absolute bottom-0 right-0 h-2 w-2 border-r-2 border-b-2 border-primary/50" />
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-border/40 bg-muted/40 font-mono text-[10px] uppercase tracking-[0.22em] text-primary/70">
                <span className="flex items-center gap-1.5">
                  <span className="text-primary/60">//</span>
                  <span>{t('dossier')}</span>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="text-emerald-400/90">{t('status.targetAcquired')}</span>
                </span>
                <button
                  onClick={() => setSelectedPlayer(null)}
                  className="p-0.5 -m-0.5 rounded text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 transition-colors"
                  aria-label={t('controls.closeDossier')}
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
                  <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('pos')}</span>
                  <span className="font-mono tabular-nums">{Math.round(selectedPlayer.x)}, {Math.round(selectedPlayer.y)}</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('floor')}</span>
                  <span className="font-mono tabular-nums">{selectedPlayer.z}</span>
                </div>
                {selectedPlayer.health !== undefined && (
                  <div className="flex justify-between items-center">
                    <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('hp')}</span>
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
                      <span className="font-mono tabular-nums w-8 text-right">{Math.round(selectedPlayer.health)}%</span>
                    </div>
                  </div>
                )}
                {selectedPlayer.accessLevel && selectedPlayer.accessLevel !== 'none' && selectedPlayer.accessLevel !== 'user' && selectedPlayer.accessLevel !== '' && (
                  <div className="flex justify-between items-baseline">
                    <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('role')}</span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-400">{selectedPlayer.accessLevel}</span>
                  </div>
                )}
                {selectedPlayer.isInfected && (
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">{t('status.label')}</span>
                    <span className="flex items-center gap-1 text-destructive font-mono text-[10px] uppercase tracking-[0.18em]">
                      <Skull className="w-3 h-3" />
                      <span>{t('infected')}</span>
                    </span>
                  </div>
                )}
              </div>
              <div className="px-2 py-1.5 border-t border-border/40 bg-muted/20 flex gap-1">
                <Button
                  size="sm" variant="ghost" className="h-7 text-xs gap-1 flex-1"
                  disabled={actionLoading !== null}
                  onClick={() => {
                    setActionLoading('heal-card')
                    panelBridgeApi.sendCommand('healPlayer', { username: selectedPlayer.username })
                      .then(() => { toast({ title: t('toast.healed'), description: t('toast.playerHealed', { username: selectedPlayer.username }) }); fetchPlayerPositions() })
                      .catch(() => toast({ title: t('toast.error'), variant: 'destructive' }))
                      .finally(() => setActionLoading(null))
                  }}
                >
                  <Heart className="w-3 h-3" /> {t('controls.heal')}
                </Button>
                <Button
                  size="sm" variant="ghost" className="h-7 text-xs gap-1 flex-1"
                  disabled={actionLoading !== null}
                  onClick={() => {
                    setActionLoading('god-card')
                    panelBridgeApi.sendCommand('setGodMode', { username: selectedPlayer.username, enabled: true })
                      .then(() => toast({ title: t('toast.godModeEnabled') }))
                      .catch(() => toast({ title: t('toast.error'), variant: 'destructive' }))
                      .finally(() => setActionLoading(null))
                  }}
                >
                  <Shield className="w-3 h-3" /> {t('controls.godMode')}
                </Button>
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
            aria-label={t('controls.mapActions')}
            className="absolute z-20 min-w-[220px] sm:min-w-[260px] rounded-md bg-card/95 backdrop-blur-md border border-border/55 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.6)] ring-1 ring-primary/10 overflow-hidden"
            style={{
              left: contextMenu.screenX,
              top: contextMenu.screenY,
              transform: [
                contextMenu.screenX > (canvasSize.width || 800) - 240 ? 'translateX(-100%)' : '',
                contextMenu.screenY > (canvasSize.height || 600) - 420 ? 'translateY(-100%)' : '',
              ].filter(Boolean).join(' ') || undefined,
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
                <span>{t('controls.mapActions')}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                <span className="text-foreground tabular-nums normal-case tracking-normal">{Math.round(contextMenu.worldX)}, {Math.round(contextMenu.worldY)}</span>
                <span className="text-muted-foreground/40 normal-case tracking-normal">·</span>
                <span className="text-muted-foreground/60 normal-case tracking-normal">{floorLabel(floor)}</span>
              </span>
              <button
                type="button"
                title={t('controls.copyCoordinates')}
                aria-label={t('controls.copyCoordinates')}
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
                    <span>{t('target')}</span>
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
                  label={t('controls.healPlayer')}
                  tone="success"
                  onClick={() => {
                    panelBridgeApi.sendCommand('healPlayer', { username: contextMenu.player!.username })
                      .then(() => { toast({ title: t('toast.healed'), description: t('toast.playerHealed', { username: contextMenu.player!.username }) }); fetchPlayerPositions() })
                      .catch(() => toast({ title: t('toast.error'), variant: 'destructive' }))
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
                    <span>{t('vehicle')}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs">
                    <strong className="text-foreground truncate">{contextMenu.vehicle.type || contextMenu.vehicle.scriptName?.split('.').pop() || t('vehicle')}</strong>
                  </div>
                  <div className="mt-1.5 space-y-1">
                    {contextMenu.vehicle.fuelPct != null && (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/70 w-9">{t('fuel')}</span>
                        <div className="flex-1 h-1.5 rounded-sm bg-muted/60 overflow-hidden ring-1 ring-black/20">
                          <div
                            className={cn("h-full transition-all", contextMenu.vehicle.fuelPct > 30 ? "bg-info/80" : contextMenu.vehicle.fuelPct > 10 ? "bg-amber-400/80" : "bg-destructive/80")}
                            style={{ width: `${Math.round(contextMenu.vehicle.fuelPct)}%` }}
                          />
                        </div>
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/80 w-8 text-right">{Math.round(contextMenu.vehicle.fuelPct)}%</span>
                      </div>
                    )}
                    {contextMenu.vehicle.batteryCharge != null && (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/70 w-9">{t('batt')}</span>
                        <div className="flex-1 h-1.5 rounded-sm bg-muted/60 overflow-hidden ring-1 ring-black/20">
                          <div
                            className={cn("h-full transition-all", contextMenu.vehicle.batteryCharge > 30 ? "bg-info/80" : contextMenu.vehicle.batteryCharge > 10 ? "bg-amber-400/80" : "bg-destructive/80")}
                            style={{ width: `${Math.round(contextMenu.vehicle.batteryCharge)}%` }}
                          />
                        </div>
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/80 w-8 text-right">{Math.round(contextMenu.vehicle.batteryCharge)}%</span>
                      </div>
                    )}
                    {contextMenu.vehicle.fuelPct == null && contextMenu.vehicle.batteryCharge == null && (
                      <div className="font-mono text-[10px] text-muted-foreground/50 italic">{t('noTelemetry')}</div>
                    )}
                  </div>
                </div>
                <ContextMenuItem
                  icon={<Wrench className="w-3.5 h-3.5 text-info" />}
                  label={t('controls.repairVehicle')}
                  tone="info"
                  loading={actionLoading === 'vehicle-repair'}
                  onClick={() => {
                    setActionLoading('vehicle-repair')
                    panelBridgeApi.sendCommand('vehicleRepair', { vehicleId: contextMenu.vehicle!.id })
                      .then((res) => {
                        if (res.success) {
                          toast({ title: t('toast.vehicleRepaired') })
                          fetchOverlays()
                        } else {
                          toast({ title: t('toast.repairFailed'), description: res.error || t('errors.unknown'), variant: 'destructive' })
                        }
                      })
                      .catch(() => toast({ title: t('toast.error'), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                  }}
                />
                <ContextMenuItem
                  icon={<Fuel className="w-3.5 h-3.5 text-info" />}
                  label={t('controls.fillFuel')}
                  tone="info"
                  loading={actionLoading === 'vehicle-fuel'}
                  onClick={() => {
                    setActionLoading('vehicle-fuel')
                    panelBridgeApi.sendCommand('vehicleSetFuel', { vehicleId: contextMenu.vehicle!.id, percent: 100 })
                      .then((res) => {
                        if (res.success) {
                          toast({ title: t('toast.fuelFilled') })
                          fetchOverlays()
                        } else {
                          toast({ title: t('toast.fuelFailed'), description: res.error || t('errors.unknown'), variant: 'destructive' })
                        }
                      })
                      .catch(() => toast({ title: t('toast.error'), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                  }}
                />
                <ContextMenuItem
                  icon={<Battery className="w-3.5 h-3.5 text-info" />}
                  label={t('controls.chargeBattery')}
                  tone="info"
                  loading={actionLoading === 'vehicle-battery'}
                  onClick={() => {
                    setActionLoading('vehicle-battery')
                    panelBridgeApi.sendCommand('vehicleSetBattery', { vehicleId: contextMenu.vehicle!.id, charge: 100 })
                      .then((res) => {
                        if (res.success) {
                          toast({ title: t('toast.batteryCharged') })
                          fetchOverlays()
                        } else {
                          toast({ title: t('toast.batteryFailed'), description: res.error || t('errors.unknown'), variant: 'destructive' })
                        }
                      })
                      .catch(() => toast({ title: t('toast.error'), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                  }}
                />
                <ContextMenuItem
                  icon={<Trash2 className="w-3.5 h-3.5 text-destructive" />}
                  label={t('controls.removeVehicle')}
                  tone="danger"
                  loading={actionLoading === 'vehicle-remove'}
                  onClick={() => {
                    setActionLoading('vehicle-remove')
                    panelBridgeApi.sendCommand('removeVehicle', { vehicleId: contextMenu.vehicle!.id })
                      .then((res) => {
                        if (res.success) {
                          toast({ title: t('toast.vehicleRemoved') })
                          fetchOverlays()
                        } else {
                          toast({ title: t('toast.removeFailed'), description: res.error || t('errors.unknown'), variant: 'destructive' })
                        }
                      })
                      .catch(() => toast({ title: t('toast.error'), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                  }}
                />
                <ContextMenuItem
                  icon={<Zap className="w-3.5 h-3.5 text-amber-400" />}
                  label={t('controls.hotwire')}
                  tone="warning"
                  loading={actionLoading === 'vehicle-hotwire'}
                  onClick={() => {
                    setActionLoading('vehicle-hotwire')
                    panelBridgeApi.sendCommand('vehicleHotwire', { vehicleId: contextMenu.vehicle!.id })
                      .then((res) => {
                        if (res.success) {
                          toast({ title: t('toast.vehicleHotwired'), description: t('toast.engineStarted') })
                        } else {
                          toast({ title: t('toast.hotwireFailed'), description: res.error || t('errors.unknown'), variant: 'destructive' })
                        }
                      })
                      .catch(() => toast({ title: t('toast.error'), variant: 'destructive' }))
                      .finally(() => { setActionLoading(null); setContextMenu(null) })
                  }}
                />
              </>
            )}

            {/* ── Teleport players to this spot ── */}
            {playersRef.current.length > 0 && (
              <div className="border-t border-border/30">
                <ContextMenuSection label={t('controls.teleport')} icon={<Locate className="w-2.5 h-2.5" />} tone="primary" />
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
                      description={`${Math.round(pl.x)}, ${Math.round(pl.y)} → ${Math.round(contextMenu.worldX)}, ${Math.round(contextMenu.worldY)}`}
                      tone="primary"
                      loading={actionLoading === 'teleport'}
                      disabled={!bridgeConnected}
                      onClick={() => {
                        teleportPlayerTo(pl.username, contextMenu.worldX, contextMenu.worldY, floor)
                        setContextMenu(null)
                      }}
                    />
                  )
                })}
                {playersRef.current.length > 6 && (
                  <div className="px-2.5 py-1 font-mono text-[10px] text-muted-foreground/50 italic select-none">
                    {t('status.moreOnline', { count: playersRef.current.length - 6 })}
                  </div>
                )}
              </div>
            )}

            {/* ── World effects section ── */}
            <div className="border-t border-border/30">
              <ContextMenuSection label={t('controls.effects')} icon={<Zap className="w-2.5 h-2.5" />} tone="info" />
              <ContextMenuItem
                icon={<CloudLightning className="w-3.5 h-3.5 text-info" />}
                label={t('controls.lightningStrike')}
                description={t('tools.thunder')}
                tone="info"
                loading={actionLoading === 'lightning'}
                onClick={() => triggerLightningAt(contextMenu.worldX, contextMenu.worldY)}
              />
              <ContextMenuItem
                icon={<Volume2 className="w-3.5 h-3.5 text-amber-400" />}
                label={t('controls.createNoise')}
                description={t('tools.pullZombies')}
                tone="warning"
                loading={actionLoading === 'noise'}
                onClick={() => createNoiseAt(contextMenu.worldX, contextMenu.worldY)}
              />
              <ContextMenuItem
                icon={<Car className="w-3.5 h-3.5 text-muted-foreground" />}
                label={t('controls.spawnVehicleHere')}
                description={t('tools.spawnVehicle')}
                disabled={!bridgeConnected}
                onClick={() => {
                  setSpawnDialog({ x: Math.round(contextMenu.worldX), y: Math.round(contextMenu.worldY), z: floor })
                  setSpawnVehicleId('')
                  setContextMenu(null)
                }}
              />
            </div>

            {/* ── Drops section ── */}
            <div className="border-t border-border/30">
              <ContextMenuSection label={t('controls.drops')} icon={<Package className="w-2.5 h-2.5" />} tone="warning" />
              <ContextMenuItem
                icon={<Package className="w-3.5 h-3.5 text-amber-400" />}
                label={t('controls.customDrop')}
                description={t('tools.buildPackage')}
                tone="warning"
                disabled={!bridgeConnected}
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
                  label={t('controls.repeatLastDrop')}
                  description={lastDrop.label}
                  tone="warning"
                  loading={actionLoading === 'drop'}
                  disabled={!bridgeConnected}
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
                  <ContextMenuSection label={t('controls.savedPackages')} icon={<Save className="w-2.5 h-2.5" />} tone="muted" />
                  {dropTemplates.slice(0, 8).map((tpl) => (
                    <ContextMenuItem
                      key={tpl.id}
                      icon={<Package className="w-3.5 h-3.5 text-amber-400/70" />}
                      label={tpl.name}
                      description={t('drop.itemsCount', { count: tpl.items.length })}
                      tone="warning"
                      loading={actionLoading === 'drop'}
                      disabled={!bridgeConnected}
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
              <ContextMenuSection label={t('controls.presetCrates')} icon={<Package className="w-2.5 h-2.5" />} tone="muted" />
              {AIRDROP_PRESETS.map((preset) => (
                <ContextMenuItem
                  key={preset.id}
                  icon={<preset.icon className="w-3.5 h-3.5 text-amber-400/80" />}
                  label={t(preset.labelKey)}
                  description={t(preset.descKey)}
                  tone="warning"
                  loading={actionLoading === 'airdrop'}
                  disabled={!bridgeConnected}
                  onClick={() => callAirdrop(contextMenu.worldX, contextMenu.worldY, preset.id)}
                />
              ))}
              {!bridgeConnected && (
                <div className="mt-1 mx-2 mb-1.5 px-2 py-1.5 rounded-sm border border-destructive/30 bg-destructive/10 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-destructive/85">
                  <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
                  <span>{t('bridgeOfflineDropsUnavailable')}</span>
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
            aria-label={t('controls.mapDescription')}
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
              {t('spawn.title')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground font-mono tabular-nums">
              {t('spawn.location')}: {spawnDialog?.x}, {spawnDialog?.y} · {t('floor')} {spawnDialog?.z ?? 0}
            </div>
            <VehiclePicker
              value={spawnVehicleId}
              onChange={setSpawnVehicleId}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSpawnDialog(null)}>{t('cancel')}</Button>
            <Button
              disabled={!spawnVehicleId || actionLoading === 'spawn-vehicle'}
              onClick={() => {
                if (!spawnDialog || !spawnVehicleId) return
                setActionLoading('spawn-vehicle')
                panelBridgeApi.sendCommand('spawnVehicleAt', {
                  vehicle: spawnVehicleId,
                  x: spawnDialog.x,
                  y: spawnDialog.y,
                  z: spawnDialog.z,
                })
                  .then((res) => {
                    if (res.success) {
                      toast({ title: t('toast.vehicleSpawned'), description: t('toast.vehicleSpawnedDescription', { vehicle: spawnVehicleId.split('.').pop(), x: spawnDialog.x, y: spawnDialog.y }) })
                      fetchOverlays()
                      setSpawnDialog(null)
                    } else {
                      toast({ title: t('toast.spawnFailed'), description: res.error || t('errors.unknown'), variant: 'destructive' })
                    }
                  })
                  .catch(() => toast({ title: t('toast.error'), variant: 'destructive' }))
                  .finally(() => setActionLoading(null))
              }}
            >
              {actionLoading === 'spawn-vehicle' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
              {t('spawn.action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Custom Drop Dialog — drops one or more items at the right-clicked coords */}
      <Dialog open={!!dropDialog} onOpenChange={(open) => { if (!open) setDropDialog(null) }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="w-5 h-5 text-warning" />
              {t('drop.title')}
              {activeTemplateId && (() => {
                const tpl = dropTemplates.find((t) => t.id === activeTemplateId)
                return tpl ? (
                  <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-normal text-muted-foreground">
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
                title={t('controls.copyCoordinates')}
                onClick={() => dropDialog && copyCoords(dropDialog.x, dropDialog.y)}
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Templates bar */}
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5 mr-auto">
                <Save className="w-3.5 h-3.5" />
                {t('drop.packageTemplates')}
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
                    <option value="">{t('loadPackage')}</option>
                    {dropTemplates.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name} ({tpl.items.length})
                      </option>
                    ))}
                  </select>
                  {activeTemplateId && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 text-destructive hover:text-destructive"
                      title={t('actions.deletePackage')}
                      onClick={() => setDeleteTemplateId(activeTemplateId)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </>
              ) : (
                <span className="text-[11px] text-muted-foreground/60 italic">{t('noPackagesYetBuildOneAndSaveBelow')}</span>
              )}
            </div>

            {/* Items list — NO overflow-y-auto here so the ItemPicker dropdown isn't clipped */}
            <div className="rounded-md border border-border/50 bg-muted/10 divide-y divide-border/30">
              {dropItems.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground/60 italic">
                  {t('drop.noItems')}
                </div>
              )}
              {dropItems.map((item, idx) => (
                <div key={idx} className="flex items-end gap-2 px-2 py-2">
                  <div className="flex-1 min-w-0">
                    {idx === 0 && (
                      <Label className="text-[10px] text-muted-foreground/70 mb-1 block">{t('item')}</Label>
                    )}
                    <ItemPicker
                      value={item.itemType}
                      onChange={(val) => {
                        setDropItems((prev) => prev.map((it, i) => (i === idx ? { ...it, itemType: val } : it)))
                        setActiveTemplateId(null)
                      }}
                      placeholder={t('placeholders.searchCatalog')}
                    />
                  </div>
                  <div className="w-16 shrink-0">
                    {idx === 0 && (
                      <Label className="text-[10px] text-muted-foreground/70 mb-1 block">{t('qty')}</Label>
                    )}
                    <Input
                      type="number"
                      value={item.count}
                      min={1}
                      max={20}
                      className="h-9 text-center tabular-nums"
                      onChange={(e) => {
                        const v = parseInt(e.target.value)
                        const count = Number.isNaN(v) ? 1 : Math.max(1, Math.min(20, v))
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
                    title={t('actions.removeItem')}
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
                <Plus className="w-3.5 h-3.5 mr-1" />
                {t('drop.addItem')}
              </Button>
              <div className="text-[11px] text-muted-foreground/70 tabular-nums">
                {t('drop.validCount', { valid: dropItems.filter((it) => it.itemType.trim()).length, total: dropItems.length })}
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
                  placeholder={t('placeholders.packageName')}
                  className="h-8 flex-1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const name = templateNameInput.trim()
                      if (!name) return
                      const valid = dropItems.filter((it) => it.itemType.trim())
                      if (valid.length === 0) {
                        toast({ title: t('toast.emptyPackage'), variant: 'destructive' })
                        return
                      }
                      const id = `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
                      const tpl: DropTemplate = { id, name, items: valid.map((it) => ({ ...it })) }
                      persistDropTemplates([...dropTemplates, tpl].slice(-50))
                      setActiveTemplateId(id)
                      setSavingTemplate(false)
                      setTemplateNameInput('')
                      toast({ title: t('toast.packageSaved'), description: name })
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
                    toast({ title: t('toast.packageSaved'), description: name })
                  }}
                >
                  {t('drop.save')}
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
                <Save className="w-3.5 h-3.5 mr-2" />
                {t('drop.saveAsPackage')}
              </Button>
            )}

            {/* Options */}
            <div className="rounded-md border border-border/50 bg-muted/10 divide-y divide-border/30">
              <label className="flex items-center justify-between gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/20 transition-colors">
                <div className="flex items-start gap-2.5 min-w-0">
                  <Megaphone className="w-4 h-4 text-muted-foreground/70 mt-0.5 flex-none" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t('announceToPlayers')}</div>
                    <div className="text-[11px] text-muted-foreground/70">{t('broadcastDropLocationInServerChat')}</div>
                  </div>
                </div>
                <Switch checked={dropAnnounce} onCheckedChange={setDropAnnounce} />
              </label>
              <label className="flex items-center justify-between gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/20 transition-colors">
                <div className="flex items-start gap-2.5 min-w-0">
                  <BellRing className="w-4 h-4 text-muted-foreground/70 mt-0.5 flex-none" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t('attractZombies')}</div>
                    <div className="text-[11px] text-muted-foreground/70">{t('createsNoiseWhenItemsLand')}</div>
                  </div>
                </div>
                <Switch checked={dropAttractZombies} onCheckedChange={setDropAttractZombies} />
              </label>
              {dropAttractZombies && (
                <div className="px-3 py-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <Label className="text-xs text-muted-foreground">{t('noiseRadius')}</Label>
                    <span className="text-xs font-mono tabular-nums text-muted-foreground/80">{t('noiseRadiusValue', { count: dropSoundRadius })}</span>
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
                    <span>{t('whisper')}</span>
                    <span>{t('gunshot')}</span>
                    <span>{t('explosion')}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDropDialog(null)}>{t('cancel')}</Button>
            <Button
              disabled={dropItems.filter((it) => it.itemType.trim()).length === 0 || actionLoading === 'drop'}
              onClick={async () => {
                if (!dropDialog) return
                const valid = dropItems.filter((it) => it.itemType.trim())
                if (valid.length === 0) return
                const label = activeTemplateId
                  ? dropTemplates.find((t) => t.id === activeTemplateId)?.name
                  : valid.length === 1
                    ? valid[0].itemType.replace(/^[^.]+\./, '')
                    : `${valid.length}-item package`
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
                ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                : <Flame className="w-4 h-4 mr-2" />}
              {(() => {
                const validCount = dropItems.filter((it) => it.itemType.trim()).length
                const totalQty = dropItems.filter((it) => it.itemType.trim()).reduce((s, it) => s + it.count, 0)
                if (validCount === 0) return t('drop.action')
                if (validCount === 1) return t('drop.singleAction', { quantity: totalQty > 1 ? ` × ${totalQty}` : '' })
                return t('drop.multipleAction', { count: validCount })
              })()}
            </Button>
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
            <AlertDialogTitle>{t('deletePackage')}</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const tpl = dropTemplates.find((t) => t.id === deleteTemplateId)
                if (!tpl) return t('drop.packageWillBeRemoved')
                return t('drop.deleteDescription', { name: tpl.name, count: tpl.items.length })
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const id = deleteTemplateId
                if (!id) return
                const tpl = dropTemplates.find((t) => t.id === id)
                persistDropTemplates(dropTemplates.filter((t) => t.id !== id))
                if (activeTemplateId === id) setActiveTemplateId(null)
                setDeleteTemplateId(null)
                if (tpl) toast({ title: t('toast.packageDeleted'), description: tpl.name })
              }}
            >
              {t('actions.delete')}
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
    default: 'group-hover:border-l-primary/60 group-focus-visible:border-l-primary/60',
    primary: 'group-hover:border-l-primary/70 group-focus-visible:border-l-primary/70',
    warning: 'group-hover:border-l-amber-400/80 group-focus-visible:border-l-amber-400/80',
    danger: 'group-hover:border-l-destructive/80 group-focus-visible:border-l-destructive/80',
    info: 'group-hover:border-l-info/80 group-focus-visible:border-l-info/80',
    success: 'group-hover:border-l-emerald-400/80 group-focus-visible:border-l-emerald-400/80',
  }
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={loading || disabled}
      title={description}
      className="group relative w-full pr-2 py-1.5 text-xs flex items-stretch gap-2.5 transition-colors duration-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:outline-none"
    >
      <span
        aria-hidden
        className={cn(
          'w-[2px] -my-px shrink-0 border-l-2 border-transparent transition-colors',
          toneAccent[tone]
        )}
      />
      <span className="flex-none w-4 flex items-center justify-center pl-1">
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin text-primary/70" />
          : icon}
      </span>
      <span className="flex flex-col min-w-0 text-left flex-1">
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
  if (!player.isAlive && player.isAlive !== undefined) return hslToken('--muted-foreground', alpha)
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
