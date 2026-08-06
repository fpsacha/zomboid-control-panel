import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ShortcutDef } from '@/hooks/useKeyboardShortcuts'

interface KeyboardShortcutsHelpProps {
  open: boolean
  onClose: () => void
  shortcuts: ShortcutDef[]
}

export function KeyboardShortcutsHelp({ open, onClose, shortcuts }: KeyboardShortcutsHelpProps) {
  const { t } = useTranslation('common')
  const groups = shortcuts.reduce<Record<string, ShortcutDef[]>>((acc, s) => {
    if (!acc[s.group]) acc[s.group] = []
    acc[s.group].push(s)
    return acc
  }, {})

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent className="max-w-sm p-5" aria-label={t('keyboardShortcuts.title')}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold text-foreground">{t('keyboardShortcuts.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('keyboardShortcuts.description')}</DialogDescription>
        </DialogHeader>

        {Object.entries(groups).map(([group, items]) => (
          <div key={group} className="mb-3 last:mb-0">
            <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">{group}</h3>
            <div className="space-y-1">
              {items.map(s => (
                <div key={s.key} className="flex items-center justify-between py-0.5">
                  <span className="text-sm text-foreground/80">{s.label}</span>
                  <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                    {s.key}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}

        <p className="mt-3 text-xs text-muted-foreground">
          {t('keyboardShortcuts.inputDisabled')}
        </p>
      </DialogContent>
    </Dialog>
  )
}
