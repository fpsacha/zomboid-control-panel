import { useEffect, useState, useCallback, useRef } from 'react'
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
  FileBox
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
  path: string
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

export default function ChunkCleaner() {
  const [saves, setSaves] = useState<SaveInfo[]>([])
  const [selectedSave, setSelectedSave] = useState<string>('')
  const [chunks, setChunks] = useState<ChunkInfo[]>([])
  const [bounds, setBounds] = useState<ChunkBounds | null>(null)
  const [stats, setStats] = useState<SaveStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedChunks, setSelectedChunks] = useState<Set<string>>(new Set())
  const { toast } = useToast()
  
  // Canvas state
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 520 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null)
  const [selectionEnd, setSelectionEnd] = useState<{ x: number; y: number } | null>(null)
  const [tool, setTool] = useState<'select' | 'pan'>('select')
  
  // Delete dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [createBackup, setCreateBackup] = useState(true)
  const [deleting, setDeleting] = useState(false)
  
  // Map background state - disabled for now as coordinate mapping needs work
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [showMapBackground, _setShowMapBackground] = useState(false)
  const [mapTilesLoaded, setMapTilesLoaded] = useState<Record<string, HTMLImageElement>>({})
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_loadingTiles, setLoadingTiles] = useState(false)
  
  // Map tiles CDN - using grabofus hosted tiles from GitHub Pages
  const MAP_TILES_BASE = 'https://grabofus.github.io/zomboid-chunk-cleaner/assets'

  // Load saves
  const fetchSaves = useCallback(async () => {
    try {
      const result = await chunksApi.getSaves()
      setSaves(result.saves || [])
    } catch (error) {
      console.error('Failed to fetch saves:', error)
    }
  }, [])

  useEffect(() => {
    fetchSaves()
  }, [fetchSaves])

  // Load chunks for selected save
  const loadChunks = useCallback(async () => {
    if (!selectedSave) return
    
    setLoading(true)
    // Clear previous data immediately to avoid showing stale data
    setChunks([])
    setBounds(null)
    setStats(null)
    setSelectedChunks(new Set())
    
    try {
      const [chunksResult, statsResult] = await Promise.all([
        chunksApi.getChunks(selectedSave),
        chunksApi.getStats(selectedSave)
      ])
      
      setChunks(chunksResult.chunks || [])
      setBounds(chunksResult.bounds)
      setStats(statsResult)
      
      // Reset view
      setZoom(1)
      setPan({ x: 0, y: 0 })
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
    if (selectedSave) {
      loadChunks()
    }
  }, [selectedSave, loadChunks])

  // Handle canvas resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          setCanvasSize({ width: Math.floor(width), height: Math.floor(height) })
        }
      }
    })
    
    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !bounds || chunks.length === 0) return
    
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    
    const width = canvas.width
    const height = canvas.height
    
    // Clear canvas with dark background
    ctx.fillStyle = '#111827'
    ctx.fillRect(0, 0, width, height)
    
    // Calculate cell size based on bounds (guard against division by zero)
    const rangeX = Math.max(1, bounds.maxX - bounds.minX + 1)
    const rangeY = Math.max(1, bounds.maxY - bounds.minY + 1)
    const baseCellSize = Math.min(
      (width - 80) / rangeX,
      (height - 80) / rangeY
    )
    const cellSize = baseCellSize * zoom
    
    const offsetX = 40 + (width - 80 - rangeX * cellSize) / 2 + pan.x
    const offsetY = 40 + (height - 80 - rangeY * cellSize) / 2 + pan.y
    
    // Draw map background if enabled and tiles are loaded
    if (showMapBackground && Object.keys(mapTilesLoaded).length > 0) {
      // Draw loaded map tiles BEHIND the chunks
      ctx.save()
      ctx.globalAlpha = 0.6
      
      for (const [tileKey, img] of Object.entries(mapTilesLoaded)) {
        const [tileX, tileY] = tileKey.split('_').map(Number)
        // Each tile covers 10 chunks (100 cells / 10 cells per chunk)
        const tileChunkStartX = tileX * 10
        const tileChunkStartY = tileY * 10
        
        // Calculate pixel position for this tile
        const px = offsetX + (tileChunkStartX - bounds.minX) * cellSize
        const py = offsetY + (tileChunkStartY - bounds.minY) * cellSize
        const tileDisplaySize = cellSize * 10
        
        ctx.drawImage(img, px, py, tileDisplaySize, tileDisplaySize)
      }
      
      ctx.restore()
    } else {
      // Draw background grid pattern (fallback)
      ctx.fillStyle = '#1f2937'
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        for (let y = bounds.minY; y <= bounds.maxY; y++) {
          const px = offsetX + (x - bounds.minX) * cellSize
          const py = offsetY + (y - bounds.minY) * cellSize
          
          // Checkerboard pattern for empty cells
          if ((x + y) % 2 === 0) {
            ctx.fillRect(px, py, cellSize, cellSize)
          }
        }
      }
    }
    
    // Draw grid lines
    ctx.strokeStyle = '#374151'
    ctx.lineWidth = 1
    
    for (let x = bounds.minX; x <= bounds.maxX + 1; x++) {
      const px = offsetX + (x - bounds.minX) * cellSize
      ctx.beginPath()
      ctx.moveTo(px, offsetY)
      ctx.lineTo(px, offsetY + rangeY * cellSize)
      ctx.stroke()
    }
    
    for (let y = bounds.minY; y <= bounds.maxY + 1; y++) {
      const py = offsetY + (y - bounds.minY) * cellSize
      ctx.beginPath()
      ctx.moveTo(offsetX, py)
      ctx.lineTo(offsetX + rangeX * cellSize, py)
      ctx.stroke()
    }
    
    // Draw chunks
    for (const chunk of chunks) {
      const px = offsetX + (chunk.x - bounds.minX) * cellSize
      const py = offsetY + (chunk.y - bounds.minY) * cellSize
      
      const key = `${chunk.x}_${chunk.y}`
      const isSelected = selectedChunks.has(key)
      
      // Color based on size (darker = bigger)
      const sizeRatio = Math.min(chunk.size / 50000, 1)
      const green = Math.floor(120 + (1 - sizeRatio) * 80)
      const blue = Math.floor(80 + (1 - sizeRatio) * 40)
      
      if (isSelected) {
        ctx.fillStyle = '#dc2626' // Red for selected
        ctx.strokeStyle = '#fca5a5'
        ctx.lineWidth = 2
      } else {
        ctx.fillStyle = `rgb(34, ${green}, ${blue})`
        ctx.strokeStyle = `rgb(50, ${green + 30}, ${blue + 20})`
        ctx.lineWidth = 1
      }
      
      const padding = 2
      ctx.fillRect(px + padding, py + padding, cellSize - padding * 2, cellSize - padding * 2)
      ctx.strokeRect(px + padding, py + padding, cellSize - padding * 2, cellSize - padding * 2)
    }
    
    // Draw coordinate labels if zoomed enough
    if (cellSize > 20) {
      ctx.font = '10px monospace'
      ctx.fillStyle = '#9ca3af'
      ctx.textAlign = 'center'
      
      // X axis labels
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        const px = offsetX + (x - bounds.minX) * cellSize + cellSize / 2
        ctx.fillText(x.toString(), px, offsetY - 5)
      }
      
      // Y axis labels
      ctx.textAlign = 'right'
      for (let y = bounds.minY; y <= bounds.maxY; y++) {
        const py = offsetY + (y - bounds.minY) * cellSize + cellSize / 2 + 3
        ctx.fillText(y.toString(), offsetX - 5, py)
      }
    }
    
    // Draw selection rectangle
    if (selectionStart && selectionEnd) {
      ctx.strokeStyle = '#3b82f6'
      ctx.fillStyle = 'rgba(59, 130, 246, 0.2)'
      ctx.lineWidth = 2
      ctx.setLineDash([5, 5])
      
      const sx = Math.min(selectionStart.x, selectionEnd.x)
      const sy = Math.min(selectionStart.y, selectionEnd.y)
      const sw = Math.abs(selectionEnd.x - selectionStart.x)
      const sh = Math.abs(selectionEnd.y - selectionStart.y)
      
      ctx.fillRect(sx, sy, sw, sh)
      ctx.strokeRect(sx, sy, sw, sh)
      ctx.setLineDash([])
    }
  }, [chunks, bounds, zoom, pan, selectedChunks, selectionStart, selectionEnd, canvasSize, showMapBackground, mapTilesLoaded])
  
  // Load map tiles when bounds change
  useEffect(() => {
    if (!bounds || !showMapBackground) return
    
    const loadTiles = async () => {
      setLoadingTiles(true)
      const loaded: Record<string, HTMLImageElement> = {}
      
      // Calculate tile coordinates needed (PZ uses ~300 cell chunks per tile, roughly 30 chunks)
      const minTileX = Math.floor(bounds.minX / 10)
      const maxTileX = Math.floor(bounds.maxX / 10)
      const minTileY = Math.floor(bounds.minY / 10)
      const maxTileY = Math.floor(bounds.maxY / 10)
      
      const tilePromises: Promise<void>[] = []
      
      for (let x = minTileX; x <= maxTileX; x++) {
        for (let y = minTileY; y <= maxTileY; y++) {
          const tileKey = `${x}_${y}`
          const promise = new Promise<void>((resolve) => {
            const img = new window.Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
              loaded[tileKey] = img
              resolve()
            }
            img.onerror = () => {
              // Tile doesn't exist, just skip
              resolve()
            }
            img.src = `${MAP_TILES_BASE}/map_${x}_${y}.png`
          })
          tilePromises.push(promise)
        }
      }
      
      await Promise.all(tilePromises)
      setMapTilesLoaded(loaded)
      setLoadingTiles(false)
    }
    
    loadTiles()
  }, [bounds, showMapBackground, MAP_TILES_BASE])

  // Mouse handlers - get properly scaled coordinates
  const getCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    
    const rect = canvas.getBoundingClientRect()
    // Account for CSS scaling - canvas internal size vs displayed size
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    }
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    
    const { x, y } = getCanvasCoords(e)
    
    if (tool === 'pan' || e.button === 1) {
      setIsDragging(true)
      setDragStart({ x: x - pan.x, y: y - pan.y })
    } else if (tool === 'select') {
      setSelectionStart({ x, y })
      setSelectionEnd({ x, y })
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    
    const { x, y } = getCanvasCoords(e)
    
    if (isDragging) {
      setPan({ x: x - dragStart.x, y: y - dragStart.y })
    } else if (selectionStart) {
      setSelectionEnd({ x, y })
    }
  }

  const handleMouseUp = useCallback((event?: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDragging) {
      setIsDragging(false)
      return
    }
    
    if (!selectionStart || !selectionEnd || !bounds) {
      setSelectionStart(null)
      setSelectionEnd(null)
      return
    }
    
    // Calculate which chunks are in selection
    const canvas = canvasRef.current
    if (!canvas) {
      setSelectionStart(null)
      setSelectionEnd(null)
      return
    }
    
    const width = canvas.width
    const height = canvas.height
    const rangeX = Math.max(1, bounds.maxX - bounds.minX + 1)
    const rangeY = Math.max(1, bounds.maxY - bounds.minY + 1)
    const baseCellSize = Math.min(
      (width - 80) / rangeX,
      (height - 80) / rangeY
    )
    const cellSize = baseCellSize * zoom
    
    const offsetX = 40 + (width - 80 - rangeX * cellSize) / 2 + pan.x
    const offsetY = 40 + (height - 80 - rangeY * cellSize) / 2 + pan.y
    
    const sx = Math.min(selectionStart.x, selectionEnd.x)
    const sy = Math.min(selectionStart.y, selectionEnd.y)
    const ex = Math.max(selectionStart.x, selectionEnd.x)
    const ey = Math.max(selectionStart.y, selectionEnd.y)
    
    const newSelected = new Set(selectedChunks)
    
    for (const chunk of chunks) {
      const px = offsetX + (chunk.x - bounds.minX) * cellSize
      const py = offsetY + (chunk.y - bounds.minY) * cellSize
      
      if (px + cellSize >= sx && px <= ex && py + cellSize >= sy && py <= ey) {
        const key = `${chunk.x}_${chunk.y}`
        if (event?.shiftKey) {
          newSelected.delete(key)
        } else {
          newSelected.add(key)
        }
      }
    }
    
    setSelectedChunks(newSelected)
    setSelectionStart(null)
    setSelectionEnd(null)
  }, [isDragging, selectionStart, selectionEnd, bounds, zoom, pan, selectedChunks, chunks])

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setZoom(z => Math.max(0.1, Math.min(5, z * delta)))
  }

  // Delete handlers
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

  const selectAll = () => {
    setSelectedChunks(new Set(chunks.map(c => `${c.x}_${c.y}`)))
  }

  const clearSelection = () => {
    setSelectedChunks(new Set())
  }

  const invertSelection = () => {
    const all = new Set(chunks.map(c => `${c.x}_${c.y}`))
    const inverted = new Set<string>()
    for (const key of all) {
      if (!selectedChunks.has(key)) {
        inverted.add(key)
      }
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
                    <TooltipContent>Select Tool</TooltipContent>
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
                    <TooltipContent>Pan Tool</TooltipContent>
                  </Tooltip>
                  
                  <Separator orientation="vertical" className="h-8" />
                  
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => setZoom(z => Math.min(5, z * 1.2))}
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
                        onClick={() => setZoom(z => Math.max(0.1, z * 0.8))}
                      >
                        <ZoomOut className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Zoom Out</TooltipContent>
                  </Tooltip>
                </div>

                <Separator />
                
                {/* Map Background Toggle - DISABLED: Grabofus tiles use different coordinate system than B42 
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {showMapBackground ? (
                      <Image className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ImageOff className="w-4 h-4 text-muted-foreground" />
                    )}
                    <Label className="text-xs">Show Map</Label>
                  </div>
                  <Switch
                    checked={showMapBackground}
                    onCheckedChange={setShowMapBackground}
                  />
                </div>
                {loadingTiles && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    Loading map tiles...
                  </div>
                )}
                */}
                
                <Separator />
                
                <div className="space-y-2">
                  <Label className="text-xs">Selection ({selectedChunks.size} chunks)</Label>
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
                    Zoom: {Math.round(zoom * 100)}%
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
                  <div ref={containerRef} className="h-[520px] w-full">
                    <canvas
                      ref={canvasRef}
                      width={canvasSize.width}
                      height={canvasSize.height}
                      className="w-full h-full rounded border cursor-crosshair"
                      onMouseDown={handleMouseDown}
                      onMouseMove={handleMouseMove}
                      onMouseUp={handleMouseUp}
                      onMouseLeave={handleMouseUp}
                      onWheel={handleWheel}
                      style={{ cursor: tool === 'pan' ? 'grab' : 'crosshair' }}
                    />
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
            <p>• <strong>Select a save</strong> - Choose the multiplayer save you want to modify</p>
            <p>• <strong>Draw selection</strong> - Click and drag on the map to select chunks</p>
            <p>• <strong>Hold Shift</strong> - While selecting to deselect chunks</p>
            <p>• <strong>Delete chunks</strong> - Selected chunks (red) will be deleted, resetting those map areas</p>
            <p>• <strong>Backup recommended</strong> - Always enable backup before deleting</p>
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
                This will permanently delete the selected chunk files. The map areas will regenerate
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
