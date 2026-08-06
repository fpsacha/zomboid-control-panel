import { useState, useEffect, useCallback } from 'react'
import { Folder, HardDrive, ChevronRight, ArrowUp, Loader2, FolderOpen, AlertCircle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { serverApi } from '@/lib/api'
import { useTranslation } from 'react-i18next'

interface DirEntry {
  name: string
  path: string
  label?: string
  isDrive?: boolean
}

interface FolderBrowserProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
  initialPath?: string
  title?: string
}

export function FolderBrowser({ open, onOpenChange, onSelect, initialPath, title }: FolderBrowserProps) {
  const { t } = useTranslation('common')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDirectory = useCallback(async (dirPath?: string) => {
    setLoading(true)
    setError(null)
    setSelectedPath(null)
    try {
      const data = await serverApi.listDirectory(dirPath)
      setEntries(data.entries)
      setCurrentPath(data.currentPath)
      setParentPath(data.parentPath)
      setPathInput(data.currentPath || '')
    } catch (e) {
      setError(e instanceof Error ? e.message : t('folderBrowser.readFailed'))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [t])

  // Load initial directory when opening
  useEffect(() => {
    if (open) {
      loadDirectory(initialPath || undefined)
    }
  }, [open, initialPath, loadDirectory])

  const handleNavigate = (path: string) => {
    loadDirectory(path)
  }

  const handleSelect = (entry: DirEntry) => {
    if (entry.isDrive) {
      handleNavigate(entry.path)
      return
    }
    setSelectedPath(entry.path)
    setPathInput(entry.path)
  }

  const handleDoubleClick = (entry: DirEntry) => {
    handleNavigate(entry.path)
  }

  const handleConfirm = () => {
    const finalPath = selectedPath || currentPath
    if (finalPath) {
      onSelect(finalPath)
      onOpenChange(false)
    }
  }

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (pathInput.trim()) {
      loadDirectory(pathInput.trim())
    }
  }

  const handleGoUp = () => {
    if (parentPath) {
      loadDirectory(parentPath)
    } else {
      // Go to drive list
      loadDirectory(undefined)
    }
  }

  const isDriveList = currentPath === null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-3 border-b border-border/50">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FolderOpen className="w-4 h-4 text-primary" />
            {title || t('folderBrowser.selectFolder')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('folderBrowser.browseDescription')}</DialogDescription>
        </DialogHeader>

        {/* Address bar */}
        <form onSubmit={handlePathSubmit} className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-muted/30">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={handleGoUp}
            disabled={isDriveList || loading}
            aria-label={t('folderBrowser.goToParent')}
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </Button>
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder={isDriveList ? t('folderBrowser.thisPc') : t('folderBrowser.enterPath')}
            className="h-7 text-xs font-mono bg-background/60 border-border/50"
          />
          <Button type="submit" variant="ghost" size="sm" className="h-7 px-2 text-xs shrink-0" disabled={loading}>
            {t('folderBrowser.go')}
          </Button>
        </form>

        {/* File listing */}
        <ScrollArea className="h-[340px]">
          {loading ? (
            <div className="flex items-center justify-center h-full py-20">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full py-16 gap-2 text-muted-foreground">
              <AlertCircle className="w-5 h-5 text-destructive" />
              <p className="text-sm">{error}</p>
              <Button variant="ghost" size="sm" onClick={() => loadDirectory(undefined)} className="text-xs mt-1">
                {t('folderBrowser.backToDrives')}
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-16 gap-1 text-muted-foreground">
              <Folder className="w-5 h-5" />
              <p className="text-sm">{t('folderBrowser.emptyFolder')}</p>
            </div>
          ) : (
            <div className="py-1">
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  className={cn(
                    'flex items-center gap-3 w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted/60',
                    selectedPath === entry.path && 'bg-primary/12 text-primary'
                  )}
                  onClick={() => handleSelect(entry)}
                  onDoubleClick={() => handleDoubleClick(entry)}
                >
                  {entry.isDrive ? (
                    <HardDrive className="w-4 h-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Folder className={cn('w-4 h-4 shrink-0', selectedPath === entry.path ? 'text-primary' : 'text-amber-600/80')} />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-[13px]">{entry.name}</p>
                    {entry.label && (
                      <p className="truncate text-xs text-muted-foreground">{entry.label}</p>
                    )}
                  </div>
                  {!entry.isDrive && (
                    <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground/50" />
                  )}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        <DialogFooter className="px-4 py-3 border-t border-border/50 bg-muted/20">
          <div className="flex items-center justify-between w-full gap-3">
            <p className="text-xs text-muted-foreground truncate min-w-0 flex-1 font-mono">
              {selectedPath || currentPath || t('folderBrowser.noFolderSelected')}
            </p>
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t('folderBrowser.cancel')}
              </Button>
              <Button size="sm" onClick={handleConfirm} disabled={!selectedPath && !currentPath}>
                {t('folderBrowser.selectFolder')}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
