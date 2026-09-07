import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Upload } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useToast } from '@/components/ui/use-toast'
import { templatesApi } from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'

interface ImportTemplateDialogProps {
  open: boolean
  onClose: () => void
  onImported: () => void
}

export function ImportTemplateDialog({ open, onClose, onImported }: ImportTemplateDialogProps) {
  const { t } = useTranslation('templateImportDialog')
  const { toast } = useToast()
  const [text, setText] = useState('')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File) => {
    // bug-hunt-2026-09-06 (client silent-failure lane): fired from the file
    // input's onChange with no .catch() at the call site -- file.text() can
    // reject (e.g. a removable/network drive going away between selection
    // and read), and an uncaught rejection here left the dialog sitting
    // open with an empty textarea and zero indication anything went wrong.
    try {
      setText(await file.text())
    } catch (err) {
      setError(getUserErrorMessage(err, t('failedToReadFile')))
    }
  }

  const handleImport = async () => {
    setImporting(true)
    setError(null)
    try {
      const parsed = JSON.parse(text)
      const result = await templatesApi.import(parsed)
      if (!result.success) throw new Error(result.error || t('failedToImport'))
      toast({
        title: t('toastImportedTitle'),
        description: t('toastImportedDesc', { name: result.template?.meta.name }),
        variant: 'success' as const,
      })
      setText('')
      onImported()
    } catch (err) {
      setError(err instanceof SyntaxError ? t('notValidJson') : getUserErrorMessage(err, t('failedToImport')))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.pztemplate.json,application/json"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          <Button variant="outline" onClick={() => fileInputRef.current?.click()} className="w-full">
            <Upload className="h-4 w-4" />
            {t('chooseFile')}
          </Button>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('pastePlaceholder')}
            rows={10}
            className="font-mono text-xs"
          />
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{t('importFailedTitle')}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importing}>{t('cancel')}</Button>
          <Button onClick={handleImport} disabled={importing || !text.trim()}>
            {importing && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
