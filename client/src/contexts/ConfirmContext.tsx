import { createContext, useCallback, useContext, useMemo, useRef, useState, ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

export interface ConfirmOptions {
  title?: string
  /** Plain text or a list of items to render as a bullet list under the description. */
  description: string
  /** Extra items to render as a bulleted list (e.g. the specific files/mods about to be deleted). */
  items?: string[]
  confirmLabel?: string
  cancelLabel?: string
  /** Renders the confirm button in the destructive (red) style. Defaults to true since this
   *  is primarily used to replace native confirm() calls guarding delete/destructive actions. */
  destructive?: boolean
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn>(async () => false)

/**
 * App-wide replacement for window.confirm(). Renders the app's themed
 * AlertDialog instead of the native, unstyled browser confirm (which breaks
 * the visual language mid-flow, blocks the main thread, can't show rich
 * context, and behaves inconsistently in embedded/kiosk webviews).
 *
 * Usage: const confirm = useConfirm(); if (!(await confirm({ description: '...' }))) return
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common')
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const [open, setOpen] = useState(false)
  const resolveRef = useRef<((value: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setOptions(opts)
      setOpen(true)
    })
  }, [])

  const settle = useCallback((value: boolean) => {
    setOpen(false)
    resolveRef.current?.(value)
    resolveRef.current = null
  }, [])

  const value = useMemo(() => confirm, [confirm])

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <AlertDialog open={open} onOpenChange={(next) => { if (!next) settle(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title ?? t('dialog.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              {options?.description}
            </AlertDialogDescription>
            {options?.items && options.items.length > 0 && (
              <ul className="mt-1 max-h-48 list-disc space-y-0.5 overflow-y-auto rounded-md border border-border/50 bg-muted/30 p-3 pl-7 text-sm text-muted-foreground">
                {options.items.map((item) => (
                  <li key={item} className="truncate">{item}</li>
                ))}
              </ul>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>
              {options?.cancelLabel ?? t('actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => settle(true)}
              className={cn(options?.destructive !== false && buttonVariants({ variant: 'destructive' }))}
            >
              {options?.confirmLabel ?? t('actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  return useContext(ConfirmContext)
}
