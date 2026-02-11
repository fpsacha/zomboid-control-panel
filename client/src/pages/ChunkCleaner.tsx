import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { 
  Map, 
  Trash2, 
  RefreshCw,
  AlertTriangle,
  Save,
  ZoomIn,
  ZoomOut,
  Move,
  Square,
  Info,
  Database,
  FileBox,
  Maximize,
  Image,
  ImageOff
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useToast } from '@/components/ui/use-toast'
import { Separator } from '@/components/ui/separator'
import { chunksApi } from '@/lib/api'

interface SaveInfo {
  name: string
  modified: string
  chunkCount: number
  size: number
  sizeFormatted: string
}

interface ChunkInfo {
  file: string
  x: number
  y: number
  size: number
  modified: string
  source?: string
}

interface ChunkBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface SaveStats {
  saveName: string
  totalSize: number
  totalSizeFormatted: string
  folders: Record<string, { fileCount: number; size: number; sizeFormatted: string }>
  playersDbSize?: number
  vehiclesDbSize?: number
}

// Camera: screenX = worldX * scale + offset.x
// Each chunk occupies 1x1 in world space (world unit = 1 chunk)
const MIN_SCALE = 0.5    // px per chunk (zoomed way out)
const MAX_SCALE = 60     // px per chunk (zoomed way in)
const MAP_TILE_SIZE = 100 // each grabofus tile covers 100x100 chunks
const MAP_TILES_CDN = 'https://grabofus.github.io/zomboid-chunk-cleaner/assets'

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

export default function ChunkCleaner() {
  const [saves, setSaves] = useState<SaveInfo[]>([])
  const [selectedSave, setSelectedSave] = useState<string>('')
  const [chunks, setChunks] = useState<ChunkInfo[]>([])
  const [bounds, setBounds] = useState<ChunkBounds | null>(null)
  const [stats, setStats] = useState<SaveStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedChunks, setSelectedChunks] = useState<Set<string>>(new Set())
  const { toast } = useToast()
  
  // Canvas refs  
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  
  // Camera state: screen = world * scale + offset
  const [scale, setScale] = useState(4)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  
  // Interaction state
  const [tool, setTool] = useState<'select' | 'pan'>('select')
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ x: 0, y: 0, ox: 0, oy: 0 })
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null)
  const [selectionEnd, setSelectionEnd] = useState<{ x: number; y: number } | null>(null)
  
  // Hover state as ref (avoids re-render on every mouse move)
  const hoverWorldRef = useRef<{ x: number; y: number } | null>(null)
  const drawRequestRef = useRef(0)
  
  // Map tile state
  const [showMap, setShowMap] = useState(true)
  const tileCacheRef = useRef<Record<string, HTMLImageElement | null>>({})
  const tileLoadCountRef = useRef(0)
  
  // Chunk limit warning
  const [limitReached, setLimitReached] = useState(false)
  
  // Delete dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [createBackup, setCreateBackup] = useState(true)
  const [deleting, setDeleting] = useState(false)

  // O(1) chunk lookup by coordinate key "x_y"
  const chunkMap = useMemo(() => {
    const lookup: Record<string, ChunkInfo> = {}
    for (const chunk of chunks) lookup[`${chunk.x}_${chunk.y}`] = chunk
    return lookup
  }, [chunks])

  // Total size of selected chunks (memoized for display)
  const selectedSize = useMemo(() => {
    let total = 0
    for (const chunk of chunks) {
      if (selectedChunks.has(`${chunk.x}_${chunk.y}`)) total += chunk.size || 0
    }
    return total
  }, [chunks, selectedChunks])

  // Whether the canvas container is in the DOM
  const hasCanvas = !!selectedSave && !loading && chunks.length > 0

  // ─── Coordinate transforms ───
  const screenToWorld = useCallback((sx: number, sy: number) => ({
    x: (sx - offset.x) / scale,
    y: (sy - offset.y) / scale
  }), [scale, offset])
  
  const getCanvasMousePos = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  // ─── Data loading ───
  const fetchSaves = useCallback(async () => {
    try {
      const result = await chunksApi.getSaves()
      setSaves(result.saves || [])
    } catch (error) {
      console.error('Failed to fetch saves:', error)
    }
  }, [])

  useEffect(() => { fetchSaves() }, [fetchSaves])

  const loadChunks = useCallback(async () => {
    if (!selectedSave) return
    setLoading(true)
    setChunks([])
    setBounds(null)
    setStats(null)
    setSelectedChunks(new Set())
    setLimitReached(false)
    
    try {
      const [chunksResult, statsResult] = await Promise.all([
        chunksApi.getChunks(selectedSave),
        chunksApi.getStats(selectedSave)
      ])
      setChunks(chunksResult.chunks || [])
      setBounds(chunksResult.bounds)
      setStats(statsResult)
      setLimitReached(chunksResult.limitReached === true)
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load chunks',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [selectedSave, toast])

  useEffect(() => {
    if (selectedSave) loadChunks()
  }, [selectedSave, loadChunks])

  // ─── Fit view to show all chunks ───
  const fitView = useCallback(() => {
    if (!bounds || canvasSize.width === 0 || canvasSize.height === 0) return
    const rangeX = bounds.maxX - bounds.minX + 1
    const rangeY = bounds.maxY - bounds.minY + 1
    const padding = 40
    const fitScale = Math.min(
      (canvasSize.width - padding * 2) / rangeX,
      (canvasSize.height - padding * 2) / rangeY
    )
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fitScale))
    const centerX = (bounds.minX + bounds.maxX + 1) / 2
    const centerY = (bounds.minY + bounds.maxY + 1) / 2
    setScale(newScale)
    setOffset({
      x: canvasSize.width / 2 - centerX * newScale,
      y: canvasSize.height / 2 - centerY * newScale
    })
  }, [bounds, canvasSize])

  // Auto-fit when chunks load or canvas resizes
  useEffect(() => { fitView() }, [fitView])

  // ─── Canvas resize observer ───
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(entries => {
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

  // ─── Map tile loading (lazy, on-demand) ───
  const loadMapTile = useCallback((tileX: number, tileY: number) => {
    const key = `${tileX}_${tileY}`
    if (key in tileCacheRef.current) return
    tileCacheRef.current[key] = null // mark as loading
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      tileCacheRef.current[key] = img
      tileLoadCountRef.current++
      // Trigger a redraw when tile loads
      if (drawRequestRef.current === 0) {
        drawRequestRef.current = requestAnimationFrame(() => { drawRequestRef.current = 0 })
      }
    }
    img.onerror = () => { /* tile missing, keep null */ }
    img.src = `${MAP_TILES_CDN}/map_${tileX}_${tileY}.png`
  }, [])

  // ─── Canvas draw (extracted to callable function for rAF use) ───
  const drawCanvasRef = useRef<() => void>(() => {})
  
  useEffect(() => {
    drawCanvasRef.current = () => {
      const canvas = canvasRef.current
      if (!canvas || canvasSize.width === 0 || canvasSize.height === 0) return
      
      canvas.width = canvasSize.width
      canvas.height = canvasSize.height
      
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      
      const W = canvasSize.width
      const H = canvasSize.height
      
      // Dark background
      ctx.fillStyle = '#0f1117'
      ctx.fillRect(0, 0, W, H)
      
      if (!bounds || chunks.length === 0) return
      
      // Visible world bounds (with 1-chunk margin)
      const visMinX = Math.floor(-offset.x / scale) - 1
      const visMaxX = Math.ceil((W - offset.x) / scale) + 1
      const visMinY = Math.floor(-offset.y / scale) - 1
      const visMaxY = Math.ceil((H - offset.y) / scale) + 1
      
      // ── Map tiles ──
      if (showMap) {
        const minTX = Math.floor(visMinX / MAP_TILE_SIZE)
        const maxTX = Math.floor(visMaxX / MAP_TILE_SIZE)
        const minTY = Math.floor(visMinY / MAP_TILE_SIZE)
        const maxTY = Math.floor(visMaxY / MAP_TILE_SIZE)
        
        ctx.save()
        ctx.globalAlpha = 0.5
        for (let ty = minTY; ty <= maxTY; ty++) {
          for (let tx = minTX; tx <= maxTX; tx++) {
            loadMapTile(tx, ty)
            const img = tileCacheRef.current[`${tx}_${ty}`]
            if (img) {
              const sx = tx * MAP_TILE_SIZE * scale + offset.x
              const sy = ty * MAP_TILE_SIZE * scale + offset.y
              const sw = MAP_TILE_SIZE * scale
              ctx.drawImage(img, sx, sy, sw, sw)
            }
          }
        }
        ctx.restore()
      }
      
      // ── Grid lines (only when zoomed in enough) ──
      if (scale > 4) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)'
        ctx.lineWidth = 1
        
        const gridMinX = Math.max(bounds.minX, visMinX)
        const gridMaxX = Math.min(bounds.maxX + 1, visMaxX)
        const gridMinY = Math.max(bounds.minY, visMinY)
        const gridMaxY = Math.min(bounds.maxY + 1, visMaxY)
        
        for (let x = gridMinX; x <= gridMaxX; x++) {
          const sx = Math.floor(x * scale + offset.x) + 0.5
          if (sx >= 0 && sx <= W) {
            ctx.beginPath()
            ctx.moveTo(sx, 0)
            ctx.lineTo(sx, H)
            ctx.stroke()
          }
        }
        for (let y = gridMinY; y <= gridMaxY; y++) {
          const sy = Math.floor(y * scale + offset.y) + 0.5
          if (sy >= 0 && sy <= H) {
            ctx.beginPath()
            ctx.moveTo(0, sy)
            ctx.lineTo(W, sy)
            ctx.stroke()
          }
        }
      }
      
      // ── Draw chunks ──
      for (const chunk of chunks) {
        if (chunk.x + 1 < visMinX || chunk.x > visMaxX || chunk.y + 1 < visMinY || chunk.y > visMaxY) continue
        
        const sx = chunk.x * scale + offset.x
        const sy = chunk.y * scale + offset.y
        const key = `${chunk.x}_${chunk.y}`
        const isSelected = selectedChunks.has(key)
        
        if (isSelected) {
          ctx.fillStyle = 'rgba(220, 38, 38, 0.85)'
        } else {
          const ratio = Math.min(chunk.size / 50000, 1)
          const g = Math.floor(140 + (1 - ratio) * 60)
          const b = Math.floor(100 + (1 - ratio) * 40)
          ctx.fillStyle = `rgba(34, ${g}, ${b}, 0.75)`
        }
        
        if (scale > 4) {
          const gap = Math.max(0.5, scale * 0.06)
          ctx.fillRect(sx + gap, sy + gap, scale - gap * 2, scale - gap * 2)
        } else {
          ctx.fillRect(sx, sy, Math.max(scale, 1), Math.max(scale, 1))
        }
      }
      
      // ── Coordinate labels (when zoomed in) ──
      if (scale > 18) {
        const fontSize = Math.min(10, scale * 0.5)
        ctx.font = `${fontSize}px monospace`
        ctx.fillStyle = 'rgba(156, 163, 175, 0.6)'
        
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        for (let x = Math.max(bounds.minX, visMinX); x <= Math.min(bounds.maxX, visMaxX); x++) {
          const sx = (x + 0.5) * scale + offset.x
          if (sx >= 0 && sx <= W) {
            const tickY = bounds.minY * scale + offset.y - 3
            if (tickY > -20 && tickY < H) ctx.fillText(x.toString(), sx, tickY)
          }
        }
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        for (let y = Math.max(bounds.minY, visMinY); y <= Math.min(bounds.maxY, visMaxY); y++) {
          const sy = (y + 0.5) * scale + offset.y
          if (sy >= 0 && sy <= H) {
            const tickX = bounds.minX * scale + offset.x - 4
            if (tickX > -60 && tickX < W) ctx.fillText(y.toString(), tickX, sy)
          }
        }
      }
      
      // ── Selection rectangle ──
      if (selectionStart && selectionEnd) {
        const wsx = Math.min(selectionStart.x, selectionEnd.x)
        const wsy = Math.min(selectionStart.y, selectionEnd.y)
        const wex = Math.max(selectionStart.x, selectionEnd.x)
        const wey = Math.max(selectionStart.y, selectionEnd.y)
        
        const s1x = selectionStart.x * scale + offset.x
        const s1y = selectionStart.y * scale + offset.y
        const s2x = selectionEnd.x * scale + offset.x
        const s2y = selectionEnd.y * scale + offset.y
        
        const rx = Math.min(s1x, s2x)
        const ry = Math.min(s1y, s2y)
        const rw = Math.abs(s2x - s1x)
        const rh = Math.abs(s2y - s1y)
        
        ctx.fillStyle = 'rgba(59, 130, 246, 0.15)'
        ctx.fillRect(rx, ry, rw, rh)
        ctx.strokeStyle = '#3b82f6'
        ctx.lineWidth = 2
        ctx.setLineDash([6, 4])
        ctx.strokeRect(rx, ry, rw, rh)
        ctx.setLineDash([])
        
        // Selection preview: count chunks in selection region
        let selCount = 0
        for (const c of chunks) {
          if (c.x + 1 > wsx && c.x < wex && c.y + 1 > wsy && c.y < wey) selCount++
        }
        
        if (selCount > 0 && rw > 30) {
          const selLabel = `${selCount} chunk${selCount !== 1 ? 's' : ''}`
          ctx.font = '11px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'bottom'
          const mx = rx + rw / 2
          const lm = ctx.measureText(selLabel)
          ctx.fillStyle = 'rgba(59, 130, 246, 0.9)'
          const pw = lm.width + 10
          ctx.fillRect(mx - pw / 2, ry - 18, pw, 16)
          ctx.fillStyle = '#fff'
          ctx.fillText(selLabel, mx, ry - 4)
        }
      }
      
      // ── Hover highlight ──
      const hover = hoverWorldRef.current
      if (hover) {
        const hx = Math.floor(hover.x)
        const hy = Math.floor(hover.y)
        const shx = hx * scale + offset.x
        const shy = hy * scale + offset.y
        
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
        ctx.lineWidth = 1.5
        ctx.strokeRect(shx, shy, scale, scale)
      }
      
      // ── HUD: coordinates + zoom ──
      ctx.font = '11px monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'bottom'
      
      if (hover) {
        const hx = Math.floor(hover.x)
        const hy = Math.floor(hover.y)
        const hkey = `${hx}_${hy}`
        const hoverChunk = chunkMap[hkey]
        const hoverSel = selectedChunks.has(hkey)
        
        let label = `Chunk ${hx}, ${hy}`
        if (hoverChunk) {
          label += ` | ${formatSize(hoverChunk.size)}${hoverSel ? ' | SELECTED' : ''}`
        }
        
        const metrics = ctx.measureText(label)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
        ctx.fillRect(6, H - 22, metrics.width + 12, 18)
        ctx.fillStyle = '#e5e7eb'
        ctx.fillText(label, 12, H - 8)
      }
      
      ctx.textAlign = 'right'
      const zLabel = `${scale.toFixed(1)} px/chunk`
      const zm = ctx.measureText(zLabel)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
      ctx.fillRect(W - zm.width - 16, H - 22, zm.width + 12, 18)
      ctx.fillStyle = 'rgba(156, 163, 175, 0.7)'
      ctx.fillText(zLabel, W - 10, H - 8)
    }
    
    // Initial draw
    drawCanvasRef.current()
  }, [chunks, chunkMap, bounds, scale, offset, selectedChunks, selectionStart, selectionEnd, canvasSize, showMap, loadMapTile])

  // Schedule a canvas redraw via requestAnimationFrame (used by mouse handlers)
  const scheduleDraw = useCallback(() => {
    if (drawRequestRef.current) return
    drawRequestRef.current = requestAnimationFrame(() => {
      drawRequestRef.current = 0
      drawCanvasRef.current()
    })
  }, [])
  
  // Cleanup rAF on unmount
  useEffect(() => {
    return () => { if (drawRequestRef.current) cancelAnimationFrame(drawRequestRef.current) }
  }, [])

  // Prevent page scroll when wheeling over the canvas (React onWheel is passive)
  useEffect(() => {
    if (!hasCanvas) return
    const container = containerRef.current
    if (!container) return
    const preventScroll = (e: WheelEvent) => { e.preventDefault() }
    container.addEventListener('wheel', preventScroll, { passive: false })
    return () => container.removeEventListener('wheel', preventScroll)
  }, [hasCanvas])

  // ─── Keyboard shortcuts ───
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (deleteDialogOpen) return
      if (!selectedSave) return
      
      switch (e.key) {
        case 'Escape':
          setSelectionStart(null)
          setSelectionEnd(null)
          setSelectedChunks(new Set())
          break
        case 'Delete':
          if (selectedChunks.size > 0) setDeleteDialogOpen(true)
          break
        case '1':
          setTool('select')
          break
        case '2':
          setTool('pan')
          break
      }
    }
    
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedChunks.size, deleteDialogOpen, selectedSave])

  // ─── Mouse handlers ───
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const pos = getCanvasMousePos(e)
    
    if (tool === 'pan' || e.button === 1 || e.button === 2) {
      isPanningRef.current = true
      panStartRef.current = { x: pos.x, y: pos.y, ox: offset.x, oy: offset.y }
    } else if (tool === 'select' && e.button === 0) {
      const world = screenToWorld(pos.x, pos.y)
      setSelectionStart(world)
      setSelectionEnd(world)
    }
  }, [tool, offset, getCanvasMousePos, screenToWorld])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getCanvasMousePos(e)
    const world = screenToWorld(pos.x, pos.y)
    hoverWorldRef.current = world
    
    if (isPanningRef.current) {
      const dx = pos.x - panStartRef.current.x
      const dy = pos.y - panStartRef.current.y
      setOffset({ x: panStartRef.current.ox + dx, y: panStartRef.current.oy + dy })
    } else if (selectionStart) {
      setSelectionEnd(world)
    } else {
      // Only hover changed — redraw via rAF without re-rendering
      scheduleDraw()
    }
  }, [selectionStart, getCanvasMousePos, screenToWorld, scheduleDraw])

  // Commit a selection (shared by mouseUp and mouseLeave)
  const commitSelection = useCallback((shiftKey: boolean) => {
    if (!selectionStart || !selectionEnd) return
    
    const sx = Math.min(selectionStart.x, selectionEnd.x)
    const sy = Math.min(selectionStart.y, selectionEnd.y)
    const ex = Math.max(selectionStart.x, selectionEnd.x)
    const ey = Math.max(selectionStart.y, selectionEnd.y)
    
    // If selection area is very small (click), toggle the single chunk under cursor
    const isClick = Math.abs(ex - sx) < 0.5 && Math.abs(ey - sy) < 0.5
    
    setSelectedChunks(prev => {
      const newSelected = new Set(prev)
      
      if (isClick) {
        const cx = Math.floor((sx + ex) / 2)
        const cy = Math.floor((sy + ey) / 2)
        const key = `${cx}_${cy}`
        if (chunkMap[key]) {
          if (shiftKey || prev.has(key)) {
            newSelected.delete(key)
          } else {
            newSelected.add(key)
          }
        }
      } else {
        for (const chunk of chunks) {
          if (chunk.x + 1 > sx && chunk.x < ex && chunk.y + 1 > sy && chunk.y < ey) {
            const key = `${chunk.x}_${chunk.y}`
            if (shiftKey) {
              newSelected.delete(key)
            } else {
              newSelected.add(key)
            }
          }
        }
      }
      
      return newSelected
    })
    
    setSelectionStart(null)
    setSelectionEnd(null)
  }, [selectionStart, selectionEnd, chunks, chunkMap])

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanningRef.current) {
      isPanningRef.current = false
      return
    }
    
    commitSelection(e.shiftKey)
  }, [commitSelection])

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const pos = getCanvasMousePos(e)
    const factor = e.deltaY > 0 ? 0.88 : 1.14
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor))
    
    // Zoom centered on mouse position
    const worldX = (pos.x - offset.x) / scale
    const worldY = (pos.y - offset.y) / scale
    setScale(newScale)
    setOffset({
      x: pos.x - worldX * newScale,
      y: pos.y - worldY * newScale
    })
  }, [scale, offset, getCanvasMousePos])

  const handleMouseLeave = useCallback(() => {
    hoverWorldRef.current = null
    if (isPanningRef.current) {
      isPanningRef.current = false
    }
    // Commit selection if one was in progress (don't lose the work)
    if (selectionStart && selectionEnd) {
      commitSelection(false)
    }
    scheduleDraw()
  }, [selectionStart, selectionEnd, commitSelection, scheduleDraw])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  // ─── Delete handlers ───
  const handleDelete = async () => {
    if (selectedChunks.size === 0) return
    
    setDeleting(true)
    try {
      const chunksToDelete = chunks
        .filter(c => selectedChunks.has(`${c.x}_${c.y}`))
        .map(c => ({ file: c.file, x: c.x, y: c.y, source: c.source }))
      
      const result = await chunksApi.deleteChunks(selectedSave, chunksToDelete, createBackup)
      
      toast({
        title: 'Chunks Deleted',
        description: `Deleted ${result.deleted} chunks${createBackup ? ' (backup created)' : ''}`,
      })
      
      setDeleteDialogOpen(false)
      setSelectedChunks(new Set())
      loadChunks()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete chunks',
        variant: 'destructive',
      })
    } finally {
      setDeleting(false)
    }
  }

  const selectAll = () => setSelectedChunks(new Set(chunks.map(c => `${c.x}_${c.y}`)))
  const clearSelection = () => setSelectedChunks(new Set())
  const invertSelection = () => {
    const all = new Set(chunks.map(c => `${c.x}_${c.y}`))
    const inverted = new Set<string>()
    for (const key of all) {
      if (!selectedChunks.has(key)) inverted.add(key)
    }
    setSelectedChunks(inverted)
  }

  return (
    <TooltipProvider>
      <div className="space-y-4 page-transition">
        {/* Header */}
        <PageHeader
          title="Chunk Cleaner"
          description="Reset map areas to regenerate loot and buildings"
          icon={<Map className="w-5 h-5" />}
        />

        {/* Warning */}
        <div className="p-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-yellow-500">Caution: This tool modifies save files</p>
            <p className="text-muted-foreground">
              Deleting chunks will reset those areas. Any player constructions, loot, or zombies in those areas will be lost.
              Always create a backup before making changes. Stop the server before editing saves.
            </p>
          </div>
        </div>

        {/* Limit Warning */}
        {limitReached && (
          <div className="p-3 rounded-lg border border-orange-500/50 bg-orange-500/10 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-orange-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-orange-500">Chunk limit reached</p>
              <p className="text-muted-foreground">
                Only the first {chunks.length.toLocaleString()} chunks are shown. The save contains more chunks than can be displayed.
                Use the region delete feature or select smaller areas at a time.
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          {/* Left Panel - Controls */}
          <div className="space-y-4">
            {/* Save Selection */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Save className="w-4 h-4" />
                  Select Save
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Select value={selectedSave} onValueChange={setSelectedSave}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a save..." />
                  </SelectTrigger>
                  <SelectContent>
                    {saves.map(save => (
                      <SelectItem key={save.name} value={save.name}>
                        <div className="flex items-center justify-between w-full">
                          <span>{save.name}</span>
                          <Badge variant="secondary" className="ml-2 text-xs">
                            {save.sizeFormatted}
                          </Badge>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="w-full"
                  onClick={fetchSaves}
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Refresh
                </Button>
              </CardContent>
            </Card>

            {/* Stats */}
            {stats && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Database className="w-4 h-4" />
                    Save Statistics
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total Size</span>
                    <span className="font-medium">{stats.totalSizeFormatted}</span>
                  </div>
                  <Separator />
                  {Object.entries(stats.folders).map(([folder, info]) => (
                    <div key={folder} className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{folder}</span>
                      <span>{info.fileCount} files ({info.sizeFormatted})</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Tools */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Tools</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={tool === 'select' ? 'default' : 'outline'}
                        size="icon"
                        onClick={() => setTool('select')}
                      >
                        <Square className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Select Tool (1)</TooltipContent>
                  </Tooltip>
                  
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={tool === 'pan' ? 'default' : 'outline'}
                        size="icon"
                        onClick={() => setTool('pan')}
                      >
                        <Move className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Pan Tool (2) — also right-click drag</TooltipContent>
                  </Tooltip>
                  
                  <Separator orientation="vertical" className="h-8" />
                  
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => {
                          const newScale = Math.min(MAX_SCALE, scale * 1.3)
                          const cx = canvasSize.width / 2
                          const cy = canvasSize.height / 2
                          const wx = (cx - offset.x) / scale
                          const wy = (cy - offset.y) / scale
                          setScale(newScale)
                          setOffset({ x: cx - wx * newScale, y: cy - wy * newScale })
                        }}
                      >
                        <ZoomIn className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Zoom In</TooltipContent>
                  </Tooltip>
                  
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => {
                          const newScale = Math.max(MIN_SCALE, scale * 0.7)
                          const cx = canvasSize.width / 2
                          const cy = canvasSize.height / 2
                          const wx = (cx - offset.x) / scale
                          const wy = (cy - offset.y) / scale
                          setScale(newScale)
                          setOffset({ x: cx - wx * newScale, y: cy - wy * newScale })
                        }}
                      >
                        <ZoomOut className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Zoom Out</TooltipContent>
                  </Tooltip>
                  
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="icon" onClick={fitView}>
                        <Maximize className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Fit All Chunks</TooltipContent>
                  </Tooltip>
                </div>

                <Separator />
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {showMap ? (
                      <Image className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ImageOff className="w-4 h-4 text-muted-foreground" />
                    )}
                    <Label className="text-xs">Map Background</Label>
                  </div>
                  <Switch checked={showMap} onCheckedChange={setShowMap} />
                </div>
                
                <Separator />
                
                <div className="space-y-2">
                  <Label className="text-xs">Selection ({selectedChunks.size} chunks{selectedChunks.size > 0 ? ` — ${formatSize(selectedSize)}` : ''})</Label>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={selectAll} disabled={chunks.length === 0}>
                      Select All
                    </Button>
                    <Button variant="outline" size="sm" onClick={clearSelection} disabled={selectedChunks.size === 0}>
                      Clear
                    </Button>
                    <Button variant="outline" size="sm" onClick={invertSelection} disabled={chunks.length === 0}>
                      Invert
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Delete Button */}
            {selectedChunks.size > 0 && (
              <Button 
                variant="destructive" 
                className="w-full"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete {selectedChunks.size} Chunks
              </Button>
            )}
          </div>

          {/* Right Panel - Canvas */}
          <div className="lg:col-span-3">
            <Card className="h-[600px]">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Map className="w-4 h-4" />
                    Chunk Map
                    {bounds && (
                      <Badge variant="secondary" className="text-xs">
                        {chunks.length} chunks | X: {bounds.minX}-{bounds.maxX} | Y: {bounds.minY}-{bounds.maxY}
                      </Badge>
                    )}
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">
                    Zoom: {scale.toFixed(1)} px/chunk
                  </span>
                </div>
              </CardHeader>
              <CardContent className="p-2">
                {!selectedSave ? (
                  <div className="h-[520px] flex items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <FileBox className="w-12 h-12 mx-auto mb-4 opacity-50" />
                      <p>Select a save to view chunks</p>
                    </div>
                  </div>
                ) : loading ? (
                  <div className="h-[520px] flex items-center justify-center">
                    <RefreshCw className="w-8 h-8 animate-spin text-muted-foreground" />
                  </div>
                ) : chunks.length === 0 ? (
                  <div className="h-[520px] flex items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <Map className="w-12 h-12 mx-auto mb-4 opacity-50" />
                      <p>No chunk data found in this save</p>
                      <p className="text-sm">The map folder may be empty</p>
                    </div>
                  </div>
                ) : (
                  <div ref={containerRef} className="h-[520px] w-full overflow-hidden">
                    {canvasSize.width > 0 && (
                      <canvas
                        ref={canvasRef}
                        width={canvasSize.width}
                        height={canvasSize.height}
                        style={{
                          width: canvasSize.width,
                          height: canvasSize.height,
                          borderRadius: '0.375rem',
                          border: '1px solid hsl(var(--border))',
                          cursor: tool === 'pan' ? 'grab' : 'crosshair'
                        }}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseLeave}
                        onWheel={handleWheel}
                        onContextMenu={handleContextMenu}
                      />
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Help */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Info className="w-4 h-4" />
              How to Use
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>• <strong>Select a save</strong> — Choose the multiplayer save you want to modify</p>
            <p>• <strong>Select chunks</strong> — Click to toggle a single chunk, or click+drag to select a region (green = data, red = selected)</p>
            <p>• <strong>Hold Shift</strong> — While clicking/dragging to deselect chunks from an existing selection</p>
            <p>• <strong>Navigate</strong> — Scroll to zoom, right-click or middle-click to pan, press 1/2 to switch tools</p>
            <p>• <strong>Map tiles</strong> — Toggle "Map Background" to overlay the PZ world map behind chunks (B41 tiles, may not cover B42 areas)</p>
            <p>• <strong>Delete chunks</strong> — Selected chunks (red) will be deleted, resetting those map areas when players revisit</p>
            <p>• <strong>Keyboard</strong> — Escape to clear selection, Delete to open delete dialog, 1/2 to switch tools</p>
            <p>• <strong>Backup recommended</strong> — Always enable backup before deleting</p>
          </CardContent>
        </Card>

        {/* Delete Confirmation Dialog */}
        <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="w-5 h-5" />
                Delete {selectedChunks.size} Chunks?
              </DialogTitle>
              <DialogDescription>
                This will permanently delete the selected chunk files ({formatSize(selectedSize)}). The map areas will regenerate
                when players visit them, but any player constructions or stored items will be lost.
              </DialogDescription>
            </DialogHeader>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-lg bg-muted">
                <div>
                  <Label>Create Backup</Label>
                  <p className="text-xs text-muted-foreground">
                    Save a copy of deleted chunks before removal
                  </p>
                </div>
                <Switch
                  checked={createBackup}
                  onCheckedChange={setCreateBackup}
                />
              </div>
              
              {!createBackup && (
                <div className="p-3 rounded-lg border border-destructive/50 bg-destructive/10 text-sm">
                  <p className="font-medium text-destructive">Warning: No backup will be created</p>
                  <p className="text-muted-foreground">Deleted chunks cannot be recovered without a backup.</p>
                </div>
              )}
            </div>
            
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                {deleting ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete Chunks
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}
