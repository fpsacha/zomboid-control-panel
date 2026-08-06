/**
 * WorkshopCollectionPanel
 * ───────────────────────
 * Daily-driver UI for reconciling locally-tracked mods with the Steam
 * Workshop collection. Lives in the Mod Manager as its own tab.
 *
 * Design intent (PZ control-room aesthetic):
 *  - Stat tiles up top tell the whole story at a glance
 *  - Drift becomes loud when present, calm when zero
 *  - One unified table with filter pills + search + bulk actions
 *  - Per-row buttons for surgical fixes
 *
 * Source of truth: `GET /api/mods/collection/diff` returns a denormalised
 * `items[]` already merged from tracked-mods + Steam collection, with
 * status, name (resolved via Steam title API) and credential state.
 *
 * The component intentionally does NOT manage settings — it links the
 * user to Settings → Workshop Collection Sync when configuration is
 * missing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  Bookmark,
  BookmarkPlus,
  Check,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Library,
  Loader2,
  Minus,
  Plus,
  Server,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  X,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { modsApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

type DiffResponse = Awaited<ReturnType<typeof modsApi.collectionDiff>>
type DiffItem = DiffResponse['items'][number]

type FilterKey = 'mismatch' | 'all' | 'tracked' | 'collection' | 'synced'
type RowAction = 'add' | 'remove' | 'track' | 'untrack' | 'add-server' | 'remove-server'

// Friendly relative-time string for the "last refreshed" badge.
function formatAgo(date: Date | null, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (!date) return t('collectionPanel.never')
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 5) return t('collectionPanel.justNow')
  if (seconds < 60) return t('collectionPanel.secondsAgo', { count: seconds })
  if (seconds < 3600) return t('collectionPanel.minutesAgo', { count: Math.floor(seconds / 60) })
  return date.toLocaleTimeString()
}

function parseSteamCookieBlob(raw: string): { sessionid?: string; steamLoginSecure?: string } {
  const text = raw.replace(/\r/g, '')
  const sessionMatch = text.match(/(?:^|[;\s'"])sessionid\s*[=:\t]\s*([A-Za-z0-9_%-]+)/i)
  const loginMatch = text.match(/(?:^|[;\s'"])steamLoginSecure\s*[=:\t]\s*([A-Za-z0-9_%|+/=.-]+)/i)
  if (!sessionMatch || !loginMatch) {
    return {}
  }
  try {
    return {
      sessionid: decodeURIComponent(sessionMatch[1]),
      steamLoginSecure: decodeURIComponent(loginMatch[1]),
    }
  } catch {
    return { sessionid: sessionMatch[1], steamLoginSecure: loginMatch[1] }
  }
}

export function WorkshopCollectionPanel() {
  const { t } = useTranslation('mods')
  const { toast } = useToast()
  const [diff, setDiff] = useState<DiffResponse | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffCheckedAt, setDiffCheckedAt] = useState<Date | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [bulkBusy, setBulkBusy] = useState<RowAction | null>(null)
  const [cookieDialogOpen, setCookieDialogOpen] = useState(false)
  const [cookiePaste, setCookiePaste] = useState('')
  const [cookieSaving, setCookieSaving] = useState(false)
  const [cookieError, setCookieError] = useState<string | null>(null)

  const [filter, setFilter] = useState<FilterKey>('mismatch')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rowBusy, setRowBusy] = useState<Record<string, RowAction | null>>({})

  const refreshSeqRef = useRef(0)
  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current
    setDiffLoading(true)
    setDiffError(null)
    try {
      const r = await modsApi.collectionDiff()
      if (seq !== refreshSeqRef.current) return
      setDiff(r)
      setDiffCheckedAt(new Date())
      if (!r.ok && r.error) setDiffError(r.error)
    } catch (err: any) {
      if (seq !== refreshSeqRef.current) return
      setDiffError(err?.message || t('collectionPanel.readFailed'))
    } finally {
      if (seq === refreshSeqRef.current) setDiffLoading(false)
    }
  }, [t])

  // Load on mount.
  useEffect(() => {
    refresh()
  }, [refresh])

  const collectionId = diff?.collectionId || ''
  const credsConfigured = !!diff?.hasCredentials
  const tokenExpired = !!diff?.tokenExpired
  const autoSync = !!diff?.autoSync
  const items: DiffItem[] = useMemo(() => (diff?.ok && diff.items) ? diff.items : [], [diff])

  // Counts per filter category — drive both the pill labels and the
  // stat tiles so they always agree.
  const counts = useMemo(() => {
    let synced = 0, toAdd = 0, collectionOnly = 0, tracked = 0, inColl = 0
    for (const it of items) {
      if (it.status === 'synced') synced++
      else if (it.status === 'to-add') toAdd++
      else if (it.status === 'collection-only') collectionOnly++
      if (it.inTracked) tracked++
      if (it.inCollection) inColl++
    }
    return { synced, toAdd, collectionOnly, tracked, inColl, total: items.length, mismatch: toAdd }
  }, [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((it) => {
      if (filter === 'mismatch' && it.status !== 'to-add') return false
      if (filter === 'synced' && it.status !== 'synced') return false
      if (filter === 'tracked' && !it.inTracked) return false
      if (filter === 'collection' && !it.inCollection) return false
      if (q) {
        if (!it.workshopId.includes(q) && !(it.name || '').toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [items, filter, search])

  // Selection helpers — selection is intentionally scoped to the
  // currently-visible (filtered) rows. Switching filter clears nothing,
  // but bulk actions only fire on rows still on screen and matching the
  // action's prerequisites.
  const visibleIds = useMemo(() => filtered.map((i) => i.workshopId), [filtered])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const someVisibleSelected = visibleIds.some((id) => selected.has(id))
  const selectedItems = useMemo(
    () => filtered.filter((item) => selected.has(item.workshopId)),
    [filtered, selected],
  )
  const canBulkTrack = selectedItems.some((item) => !item.inTracked)
  const canBulkUntrack = selectedItems.some((item) => item.inTracked)
  const canBulkRemoveServer = selectedItems.some((item) => item.inServer && !item.inCollection)

  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id))
      else visibleIds.forEach((id) => next.add(id))
      return next
    })
  }
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const clearSelection = () => setSelected(new Set())

  const saveCookies = async () => {
    const parsed = parseSteamCookieBlob(cookiePaste)
    if (!parsed.sessionid || !parsed.steamLoginSecure) {
      setCookieError(t('collectionPanel.cookiesRequiredError'))
      return
    }
    setCookieSaving(true)
    setCookieError(null)
    try {
      await modsApi.collectionSaveCookies(parsed.sessionid, parsed.steamLoginSecure)
      setCookiePaste('')
      setCookieDialogOpen(false)
      toast({ title: t('collectionPanel.cookiesSaved') })
      await refresh()
    } catch (err: any) {
      setCookieError(err?.message || t('collectionPanel.saveCookiesFailed'))
    } finally {
      setCookieSaving(false)
    }
  }

  // ── Mutations ────────────────────────────────────────────────────────
  const runRowAction = async (workshopId: string, action: RowAction) => {
    setRowBusy((prev) => ({ ...prev, [workshopId]: action }))
    try {
      if (action === 'add') {
        if (!credsConfigured) throw new Error(t('collectionPanel.cookiesRequiredDesc'))
        if (tokenExpired) throw new Error(t('collectionPanel.sessionExpiredDesc'))
        await modsApi.collectionAddItem(workshopId)
      } else if (action === 'remove') {
        if (!credsConfigured) throw new Error(t('collectionPanel.cookiesRequiredDesc'))
        if (tokenExpired) throw new Error(t('collectionPanel.sessionExpiredDesc'))
        await modsApi.collectionRemoveItem(workshopId)
      } else if (action === 'track') {
        await modsApi.trackMod(workshopId)
      } else if (action === 'untrack') {
        await modsApi.collectionUntrack(workshopId)
      } else if (action === 'add-server') {
        await modsApi.addToIni(workshopId)
        if (!items.find((item) => item.workshopId === workshopId)?.inTracked) {
          await modsApi.trackMod(workshopId)
        }
        toast({
          title: t('collectionPanel.addServer'),
          description: t('collectionPanel.serverAddDesc'),
        })
      } else if (action === 'remove-server') {
        await modsApi.batchRemove([workshopId])
        toast({
          title: t('collectionPanel.removeServer'),
          description: autoSync ? t('collectionPanel.removeFromCollection') : t('collectionPanel.collectionOnly'),
        })
      }
      await refresh()
    } catch (err: any) {
      toast({ variant: 'destructive', title: t('collectionPanel.actionFailed'), description: err?.message || t('collectionPanel.steamRejected') })
    } finally {
      setRowBusy((prev) => {
        const next = { ...prev }
        delete next[workshopId]
        return next
      })
    }
  }

  // Bulk actions iterate sequentially so we don't slam Steam with parallel
  // writes (their endpoints rate-limit cookie-auth pretty aggressively).
  // Each row's success / failure is surfaced at the end as a single toast.
  const runBulk = async (action: RowAction) => {
    if (bulkBusy) return
    // Filter selection to rows where the action makes sense.
    const targets = filtered.filter((it) => {
      if (!selected.has(it.workshopId)) return false
      if (action === 'add') return !it.inCollection
      if (action === 'remove') return it.inCollection
      if (action === 'track') return !it.inTracked
      if (action === 'untrack') return it.inTracked
      if (action === 'remove-server') return it.inServer && !it.inCollection
      return false
    })
    if (targets.length === 0) {
      toast({ title: t('collectionPanel.nothingToDo'), description: t('collectionPanel.nothingToDoDesc') })
      return
    }
    if ((action === 'add' || action === 'remove') && !credsConfigured) {
      toast({ variant: 'destructive', title: t('collectionPanel.cookiesRequired'), description: t('collectionPanel.cookiesRequiredDesc') })
      return
    }
    if ((action === 'add' || action === 'remove') && tokenExpired) {
      toast({ variant: 'destructive', title: t('collectionPanel.sessionExpired'), description: t('collectionPanel.sessionExpiredDesc') })
      return
    }
    if (action === 'remove-server') {
      setBulkBusy(action)
      targets.forEach((item) => setRowBusy((prev) => ({ ...prev, [item.workshopId]: action })))
      try {
        await modsApi.batchRemove(targets.map((item) => item.workshopId))
        toast({
          title: t('collectionPanel.removedFromServerConfig'),
          description: autoSync
            ? t('collectionPanel.removeServerCount', { count: targets.length })
            : t('collectionPanel.removeServerCountNoSync', { count: targets.length }),
        })
      } catch (err: any) {
        toast({ variant: 'destructive', title: t('collectionPanel.serverRemovalFailed'), description: err?.message || t('collectionPanel.serverUpdateFailed') })
      } finally {
        setBulkBusy(null)
        setRowBusy({})
        await refresh()
        clearSelection()
      }
      return
    }
    setBulkBusy(action)
    let ok = 0
    const errors: Array<{ id: string; error: string }> = []
    for (const it of targets) {
      setRowBusy((prev) => ({ ...prev, [it.workshopId]: action }))
      try {
        if (action === 'add') await modsApi.collectionAddItem(it.workshopId)
        else if (action === 'remove') await modsApi.collectionRemoveItem(it.workshopId)
        else if (action === 'track') await modsApi.trackMod(it.workshopId)
        else if (action === 'untrack') await modsApi.collectionUntrack(it.workshopId)
        ok++
      } catch (err: any) {
        errors.push({ id: it.workshopId, error: err?.message || t('collectionPanel.unknownError') })
      } finally {
        setRowBusy((prev) => {
          const next = { ...prev }
          delete next[it.workshopId]
          return next
        })
      }
    }
    setBulkBusy(null)
    await refresh()
    clearSelection()
    if (errors.length === 0) {
      toast({ title: t('collectionPanel.bulkComplete'), description: t('collectionPanel.bulkCompleteDesc', { count: ok }) })
    } else {
      toast({
        variant: 'destructive',
        title: t('collectionPanel.bulkActionFailed', { count: errors.length }),
        description: t('collectionPanel.bulkActionSummary', { succeeded: ok, failed: errors.length, error: errors[0].error }),
      })
    }
  }

  const handleSyncAll = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      const r = await modsApi.collectionSync()
      if (r.success) toast({ title: t('collectionPanel.collectionSynced'), description: t('collectionPanel.syncCompleteDesc') })
      else toast({ variant: 'destructive', title: t('collectionPanel.partialSync'), description: t('collectionPanel.syncPartialDesc') })
      await refresh()
    } catch (err: any) {
      toast({ variant: 'destructive', title: t('collectionPanel.syncFailed'), description: err?.message || t('collectionPanel.unknownError') })
    } finally {
      setSyncing(false)
    }
  }

  // ── Render guards ────────────────────────────────────────────────────
  const noCollectionConfigured = diff !== null && !collectionId

  // Configuration empty-state: shown when the panel is loaded but the
  // user hasn't set a collection ID yet. Points them at the Settings card.
  if (noCollectionConfigured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Library className="w-4 h-4 text-primary" />
            {t('workshopCollection')}
          </CardTitle>
          <CardDescription>
            {t('collectionPanel.setupDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center text-center py-10 gap-4 border border-dashed border-border/50 rounded-lg bg-muted/10">
            <div className="w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center">
              <Library className="w-6 h-6 text-muted-foreground" />
            </div>
            <div className="space-y-1 max-w-md">
              <h3 className="text-sm font-semibold text-foreground">{t('noCollectionConfigured')}</h3>
              <p className="text-xs text-muted-foreground">
                {t('collectionPanel.setupDescription')}
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link to="/settings#settings-workshop-collection">
                <SettingsIcon className="w-3.5 h-3.5 mr-2" />
                {t('collectionPanel.openSettings')}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const inSync = diff?.ok && counts.mismatch === 0
  const syncedRatio = counts.total > 0 ? (counts.synced / counts.total) * 100 : 0

  return (
    <Card className={cn(
      'overflow-hidden transition-colors',
      counts.mismatch > 0 ? 'border-warning/40' : ''
    )}>
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5 min-w-0">
            <CardTitle className="flex items-center gap-2 flex-wrap">
              <Library className="w-4 h-4 text-primary shrink-0" />
              <span>{t('workshopCollection')}</span>
              {diff?.title && (
                <a
                  href={collectionId ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${collectionId}` : '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-muted-foreground hover:text-primary inline-flex items-center gap-1 max-w-[280px] truncate"
                  title={diff.title}
                >
                  · {diff.title}
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              )}
            </CardTitle>
            <CardDescription className="flex items-center gap-3 flex-wrap text-xs">
              <span className="font-mono">{collectionId || '—'}</span>
              <span className="text-muted-foreground/60">·</span>
              <span>{t('collectionPanel.autoSync')} <strong className={autoSync ? 'text-success' : 'text-muted-foreground'}>{autoSync ? t('collectionPanel.on') : t('collectionPanel.off')}</strong></span>
              <span className="text-muted-foreground/60">·</span>
              <span>{t('collectionPanel.refreshed', { time: formatAgo(diffCheckedAt, t) })}</span>
              {!credsConfigured && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span className="inline-flex items-center gap-1 text-warning">
                    <AlertTriangle className="w-3 h-3" />
                    {t('collectionPanel.readOnly')}
                  </span>
                </>
              )}
              {credsConfigured && tokenExpired && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span className="inline-flex items-center gap-1 text-destructive">
                    <AlertTriangle className="w-3 h-3" />
                    {t('collectionPanel.sessionExpiredHint')}{' '}
                    <Link to="/settings" className="underline underline-offset-2">{t('collectionPanel.settings')}</Link>
                  </span>
                </>
              )}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setCookieError(null)
                setCookieDialogOpen(true)
              }}
              className="h-8 w-8 text-muted-foreground"
              title={t('collectionPanel.pasteCookies')}
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span className="sr-only">{t('pasteSteamCookies')}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={refresh}
              disabled={diffLoading}
              className="h-8 px-2 text-xs"
              title={t('collectionPanel.refreshCollection')}
            >
              <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', diffLoading && 'animate-spin')} />
              {t('refresh')}
            </Button>
            <Button asChild variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground">
              <Link to="/settings#settings-workshop-collection">
                <SettingsIcon className="w-3.5 h-3.5 mr-1.5" />
                {t('collectionPanel.configure')}
              </Link>
            </Button>
            <Button
              onClick={handleSyncAll}
              disabled={syncing || counts.mismatch === 0 || !credsConfigured || tokenExpired}
              size="sm"
              variant={counts.mismatch > 0 ? 'warning' : 'outline'}
              className="h-8"
              title={
                tokenExpired ? t('collectionPanel.sessionExpired')
                : !credsConfigured ? t('collectionPanel.cookiesRequired')
                : counts.mismatch === 0 ? t('collectionPanel.nothingToSync')
                : t('collectionPanel.pushMismatches', { count: counts.mismatch })
              }
            >
              {syncing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
              {t('collectionPanel.syncAll')}{counts.mismatch > 0 ? ` (${counts.mismatch})` : ''}
            </Button>
          </div>
        </div>
      </CardHeader>

      <Dialog open={cookieDialogOpen} onOpenChange={setCookieDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('steamCookies')}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={cookiePaste}
            onChange={(event) => setCookiePaste(event.target.value)}
            placeholder={t('collectionPanel.cookiePlaceholder')}
            className="min-h-28 font-mono text-xs"
            autoFocus
          />
          {cookieError && <p className="text-xs text-destructive">{cookieError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCookieDialogOpen(false)} disabled={cookieSaving}>{t('cancel')}</Button>
            <Button onClick={saveCookies} disabled={cookieSaving || !cookiePaste.trim()}>
              {cookieSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t('collectionPanel.saveCookies')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CardContent className="space-y-4">
        {/* Error banner */}
        {diffError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1">{diffError}</div>
          </div>
        )}

        {/* Sync summary — one calm read of the state, details tucked away. */}
        <div className={cn(
          'rounded-lg border px-3 py-3',
          inSync ? 'border-success/30 bg-success/[0.04]' : 'border-warning/35 bg-warning/[0.045]'
        )}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              {inSync ? <CheckCircle2 className="h-5 w-5 shrink-0 text-success" /> : <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />}
              <div className="min-w-0">
                <p className={cn('text-sm font-semibold', inSync ? 'text-success' : 'text-warning')}>
                  {inSync
                    ? t('collectionPanel.inSyncSummary')
                    : t('collectionPanel.mismatchSummary', { count: counts.mismatch })}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t('collectionPanel.trackedSummary', { synced: counts.synced, optional: counts.collectionOnly })}
                </p>
              </div>
            </div>
            <div className="min-w-[12rem] space-y-1.5">
              <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                <span>{Math.round(syncedRatio)}%</span>
                {!inSync && <span>{t('collectionPanel.addCount', { count: counts.toAdd })}</span>}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-border/40">
                <div className={cn('h-full rounded-full transition-all duration-500 ease-out', inSync ? 'bg-success' : 'bg-warning')} style={{ width: `${syncedRatio}%` }} />
              </div>
            </div>
          </div>
          <details className="group/collection-details mt-2 border-t border-border/25 pt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
              <span className="transition-transform group-open/collection-details:rotate-90"><Plus className="h-3 w-3" /></span>
              {t('collectionPanel.showCounts')}
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile label={t('collectionPanel.trackedLocally')} value={counts.tracked} icon={<Bookmark className="w-3.5 h-3.5" />} accent="primary" />
              <StatTile label={t('collectionPanel.inSteamCollection')} value={counts.inColl} icon={<Library className="w-3.5 h-3.5" />} accent="primary" />
              <StatTile label={t('collectionPanel.missingFromCollection')} value={counts.toAdd} icon={<Plus className="w-3.5 h-3.5" />} accent={counts.toAdd > 0 ? 'warning' : 'muted'} onClick={counts.toAdd > 0 ? () => setFilter('mismatch') : undefined} />
              <StatTile label={t('collectionPanel.collectionOnly')} value={counts.collectionOnly} icon={<Library className="w-3.5 h-3.5" />} accent={counts.collectionOnly > 0 ? 'primary' : 'muted'} onClick={counts.collectionOnly > 0 ? () => setFilter('collection') : undefined} />
            </div>
          </details>
        </div>

        {/* Toolbar: filter pills + search + bulk actions */}
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border/55 bg-muted/30 p-0.5 text-[11px] font-medium">
            {([
              ['mismatch', t('filters.mismatch'), counts.mismatch],
              ['all', t('filters.all'), counts.total],
              ['tracked', t('filters.tracked'), counts.tracked],
              ['collection', t('filters.collection'), counts.inColl],
              ['synced', t('filters.synced'), counts.synced],
            ] as Array<[FilterKey, string, number]>).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={cn(
                  'shrink-0 px-2 py-1 rounded-sm transition-colors',
                  filter === key
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                )}
              >
                {label} <span className="opacity-70">({count})</span>
              </button>
            ))}
          </div>

          <div className="relative w-full lg:w-64">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('collectionPanel.filterPlaceholder')}
              className="h-8 w-full pl-7 pr-7 text-xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={t('collectionPanel.clearSearch')}
              >
                <XCircle className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Bulk action bar — only renders when something's selected, so
            the toolbar stays calm in the common case */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 flex-wrap rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs animate-in fade-in slide-in-from-top-1">
            <span className="font-medium text-foreground">
              {t('collectionPanel.selected', { count: selected.size })}
            </span>
            <span className="text-muted-foreground/60">·</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-success hover:text-success hover:bg-success/10"
              onClick={() => runBulk('add')}
              disabled={!!bulkBusy || !credsConfigured || tokenExpired}
            >
              {bulkBusy === 'add' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Plus className="w-3 h-3 mr-1" />}
              {t('collectionPanel.addToCollection')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => runBulk('remove')}
              disabled={!!bulkBusy || !credsConfigured || tokenExpired}
            >
              {bulkBusy === 'remove' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Minus className="w-3 h-3 mr-1" />}
              {t('collectionPanel.removeFromCollection')}
            </Button>
            <span className="text-muted-foreground/40">|</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => runBulk('track')}
              disabled={!!bulkBusy || !canBulkTrack}
            >
              {bulkBusy === 'track' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <BookmarkPlus className="w-3 h-3 mr-1" />}
              {t('collectionPanel.trackLocally')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-muted-foreground"
              onClick={() => runBulk('untrack')}
              disabled={!!bulkBusy || !canBulkUntrack}
            >
              {bulkBusy === 'untrack' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Bookmark className="w-3 h-3 mr-1" />}
              {t('collectionPanel.untrack')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => runBulk('remove-server')}
              disabled={!!bulkBusy || !canBulkRemoveServer}
              title={t('collectionPanel.removeServerTitle')}
            >
              {bulkBusy === 'remove-server' ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Minus className="w-3 h-3 mr-1" />}
              {t('collectionPanel.removeServer')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] ml-auto"
              onClick={clearSelection}
            >
              <X className="w-3 h-3 mr-1" />
              {t('collectionPanel.clear')}
            </Button>
          </div>
        )}

        {/* Table */}
        <div className="rounded-md border border-border/60 overflow-hidden">
          <div className="max-h-[520px] overflow-auto">
            {diffLoading && !diff ? (
              <div className="px-3 py-10 text-center text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                {t('collectionPanel.readingCollection')}
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-10 text-center text-xs text-muted-foreground space-y-2">
                {inSync && filter === 'mismatch' ? (
                  <>
                    <CheckCircle2 className="w-6 h-6 text-success mx-auto" />
                    <div className="font-medium text-foreground">{t('everythingInSync')}</div>
                    <div>{t('trackedModsMatch')}</div>
                  </>
                ) : search ? (
                  <div>{t('noModsMatch')}</div>
                ) : (
                  <div>{t('nothingInFilter')}</div>
                )}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
                  <tr className="text-left text-muted-foreground border-b border-border/50">
                    <th className="font-medium px-3 py-2 w-[36px]">
                      <Checkbox
                        checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                        onCheckedChange={toggleSelectAllVisible}
                        aria-label={t('collectionPanel.selectAllVisible')}
                      />
                    </th>
                    <th className="font-medium px-3 py-2 w-[150px]">{t('status')}</th>
                    <th className="font-medium px-3 py-2">{t('mod')}</th>
                    <th className="font-medium px-3 py-2 w-[320px] text-right">{t('columns.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((it) => (
                    <Row
                      key={it.workshopId}
                      item={it}
                      selected={selected.has(it.workshopId)}
                      onToggleSelect={() => toggleOne(it.workshopId)}
                      busy={rowBusy[it.workshopId] || null}
                      credsConfigured={credsConfigured}
                      tokenExpired={tokenExpired}
                      onAction={(action) => runRowAction(it.workshopId, action)}
                      t={t}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-t border-border/40 bg-muted/20 text-[10px] text-muted-foreground">
            <span>
              {t('collectionPanel.shown', { shown: filtered.length, total: counts.total })}
              {selected.size > 0 && ` · ${t('collectionPanel.selected', { count: selected.size })}`}
            </span>
            <span className="hidden md:inline">
              {t('collectionPanel.clickModName')}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────────────────

type StatAccent = 'primary' | 'warning' | 'destructive' | 'muted'

function StatTile({
  label,
  value,
  icon,
  accent,
  onClick,
}: {
  label: string
  value: number
  icon: React.ReactNode
  accent: StatAccent
  onClick?: () => void
}) {
  const accentCls: Record<StatAccent, string> = {
    primary: 'border-primary/30 bg-primary/5 text-primary',
    warning: 'border-warning/40 bg-warning/5 text-warning',
    destructive: 'border-destructive/40 bg-destructive/5 text-destructive',
    muted: 'border-border/50 bg-muted/10 text-muted-foreground',
  }
  const interactive = !!onClick
  const Tag: any = interactive ? 'button' : 'div'
  return (
    <Tag
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'group rounded-md border px-3 py-2.5 text-left transition-colors',
        accentCls[accent],
        interactive && 'hover:bg-current/10 cursor-pointer'
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide opacity-80">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="text-2xl font-semibold tabular-nums mt-1 text-foreground">
        {value}
      </div>
    </Tag>
  )
}

function Row({
  item,
  selected,
  onToggleSelect,
  busy,
  credsConfigured,
  tokenExpired,
  onAction,
  t,
}: {
  item: DiffItem
  selected: boolean
  onToggleSelect: () => void
  busy: RowAction | null
  t: (key: string, options?: Record<string, unknown>) => string
  credsConfigured: boolean
  tokenExpired: boolean
  onAction: (action: RowAction) => void
}) {
  const statusMeta =
    item.status === 'synced'
      ? { label: t('collectionPanel.statusInSync'), cls: 'text-success border-success/40 bg-success/10', icon: <Check className="w-3 h-3" /> }
      : item.status === 'to-add'
        ? { label: t('collectionPanel.statusMissing'), cls: 'text-warning border-warning/40 bg-warning/10', icon: <Plus className="w-3 h-3" /> }
        : { label: t('collectionPanel.statusCollectionOnly'), cls: 'text-primary border-primary/40 bg-primary/10', icon: <Library className="w-3 h-3" /> }

  return (
    <tr className={cn(
      'border-b border-border/30 last:border-b-0 hover:bg-muted/30 transition-colors',
      selected && 'bg-primary/5'
    )}>
      <td className="px-3 py-2 align-top">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          aria-label={t('collectionPanel.selectItem', { name: item.name || item.workshopId })}
        />
      </td>
      <td className="px-3 py-2 align-top">
        <span className={cn('inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium', statusMeta.cls)}>
          {statusMeta.icon}
          {statusMeta.label}
        </span>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-col min-w-0">
          <a
            href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${item.workshopId}`}
            target="_blank"
            rel="noreferrer"
            className="truncate text-foreground hover:text-primary hover:underline underline-offset-2 font-medium inline-flex items-center gap-1"
            title={item.name || item.workshopId}
          >
            {item.name || <span className="font-mono text-muted-foreground">{item.workshopId}</span>}
            <ExternalLink className="w-2.5 h-2.5 opacity-50 shrink-0" />
          </a>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/80 font-mono">
            <span>{item.workshopId}</span>
            <span>·</span>
            <span className={item.inTracked ? '' : 'opacity-50'}>{item.inTracked ? t('collectionPanel.trackedStatus') : t('collectionPanel.notTrackedStatus')}</span>
            <span>·</span>
            <span className={item.inCollection ? '' : 'opacity-50'}>{item.inCollection ? t('collectionPanel.inCollectionStatus') : t('collectionPanel.notInCollectionStatus')}</span>
            <span>·</span>
            <span className={item.inServer ? '' : 'opacity-50'}>{item.inServer ? t('collectionPanel.onServerStatus') : t('collectionPanel.notOnServerStatus')}</span>
          </div>
        </div>
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex items-center justify-end gap-1">
          {item.inCollection ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => onAction('remove')}
              disabled={!!busy || !credsConfigured || tokenExpired}
              title={tokenExpired ? t('collectionPanel.sessionExpired') : !credsConfigured ? t('collectionPanel.needCookies') : t('collectionPanel.removeFromCollection')}
            >
              {busy === 'remove' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Minus className="w-3 h-3" />}
              <span className="ml-1 hidden sm:inline">{t('remove')}</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-success hover:text-success hover:bg-success/10"
              onClick={() => onAction('add')}
              disabled={!!busy || !credsConfigured || tokenExpired}
              title={tokenExpired ? t('collectionPanel.sessionExpired') : !credsConfigured ? t('collectionPanel.needCookies') : t('collectionPanel.addToCollection')}
            >
              {busy === 'add' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              <span className="ml-1 hidden sm:inline">{t('add')}</span>
            </Button>
          )}
          {item.inTracked ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={() => onAction('untrack')}
              disabled={!!busy}
              title={t('collectionPanel.untrack')}
            >
              {busy === 'untrack' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Bookmark className="w-3 h-3" />}
              <span className="ml-1 hidden sm:inline">{t('untrack')}</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10"
              onClick={() => onAction('track')}
              disabled={!!busy}
              title={t('collectionPanel.trackLocally')}
            >
              {busy === 'track' ? <Loader2 className="w-3 h-3 animate-spin" /> : <BookmarkPlus className="w-3 h-3" />}
              <span className="ml-1 hidden sm:inline">{t('track')}</span>
            </Button>
          )}
          {!item.inServer && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-success hover:text-success hover:bg-success/10"
              onClick={() => onAction('add-server')}
              disabled={!!busy}
              title={t('collectionPanel.addServer')}
            >
              {busy === 'add-server' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Server className="w-3 h-3" />}
              <span className="ml-1 hidden sm:inline">{t('addToServer')}</span>
            </Button>
          )}
          {item.inServer && !item.inCollection && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => onAction('remove-server')}
              disabled={!!busy}
              title={t('collectionPanel.removeServerTitle')}
            >
              {busy === 'remove-server' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Minus className="w-3 h-3" />}
              <span className="ml-1 hidden sm:inline">{t('removeServer')}</span>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={!!busy} title={t('actions.moreActions')}>
                <span className="text-base leading-none">⋯</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide">{item.workshopId}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a
                  href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${item.workshopId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="cursor-pointer"
                >
                  <ExternalLink className="w-3.5 h-3.5 mr-2" />
                  {t('collectionPanel.openOnSteam')}
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => { navigator.clipboard.writeText(item.workshopId).catch(() => {}) }}
              >
                <Library className="w-3.5 h-3.5 mr-2" />
                {t('toast.copied')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  )
}
