import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Server, X, Plus, AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { resolveRegisteredTranslation } from '@/lib/paramTranslation'
import type { DiscoveredMount, InaccessibleMountCandidate } from '@/lib/api'

const DISMISS_KEY_PREFIX = 'pz-mount-discovery-dismissed-'

function dismissKey(path: string): string {
  return DISMISS_KEY_PREFIX + path
}

function isDismissed(path: string): boolean {
  try {
    return localStorage.getItem(dismissKey(path)) === 'true'
  } catch {
    return false
  }
}

// docker-unraid-add-server-experience (2026-09-09): new copy below ships via
// this fallback rather than new locale JSON keys -- same call as the sandbox
// range-override toggle, for the same reason (resolveRegisteredTranslation
// returns null for a key registered in NO locale, so this always renders the
// English fallback for every language until a real translation is added
// later; localeParity.test.ts's 9-locale key-SET parity has nothing to be
// out of parity about since the key exists nowhere). Existing keys (pzInstall,
// dismiss*, add) are untouched and still come from mountDiscoveryBanner.json.
function bannerFallback(key: string, fallback: string): string {
  return resolveRegisteredTranslation('mountDiscoveryBanner', key, undefined) ?? fallback
}

interface MountDiscoveryBannerProps {
  mount: DiscoveredMount
  // 2026-09-09 ruling (god): a mount without a confirmed data path AND a
  // server config is no longer hidden -- it's shown with different copy and
  // a different action (hand what we found to the manual form instead of
  // the fully-automated create-from-discovery, which needs both to read
  // RCON settings from).
  confidence: 'confirmed' | 'partial'
  // The scan's own plain-language explanation for why this candidate isn't
  // 'confirmed' (Angela's `MountDiscoveryCandidate.reason`, server-computed
  // per her six-way `status`, e.g. "Found the install, but no save data
  // folder yet" vs "Found save data, but no server config yet"). Only
  // meaningful when confidence is 'partial' -- falls back to a generic
  // sentence if the caller has one but no candidate-shaped reason on hand.
  reason?: string
  onConnect: (mount: DiscoveredMount) => void
}

// Shown when the panel found PZ server files at a common bind-mount path
// but no server profile has been created for it yet — lets the user skip
// typing paths and RCON settings by hand. Dismissal is remembered per
// install path so re-scans don't keep re-surfacing a mount the user
// already declined.
export function MountDiscoveryBanner({ mount, confidence, reason, onConnect }: MountDiscoveryBannerProps) {
  const { t } = useTranslation('mountDiscoveryBanner')
  const [dismissed, setDismissed] = useState(() => isDismissed(mount.installPath))

  if (dismissed) return null

  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(mount.installPath), 'true')
    } catch {
      /* ignore storage failures */
    }
    setDismissed(true)
  }

  const partial = confidence === 'partial'

  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 ${partial ? 'border-amber-500/40 bg-amber-500/[0.06]' : 'bg-muted/10'}`}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Server className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium">
          {partial
            ? bannerFallback('foundPossibleTitle', 'Possible PZ install found')
            : t('pzInstall')}
        </span>
        <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={mount.installPath}>
          {mount.installPath}
        </code>
        {partial && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            {reason ?? bannerFallback('foundPossibleDescFallback', 'Found something here, but could not confirm it fully.')}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={dismiss} aria-label={t('dismissAria')} title={t('dismiss')}>
          <X className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => onConnect(mount)}>
          <Plus className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {partial ? bannerFallback('reviewAndAdd', 'Review & Add') : t('add')}
        </Button>
      </div>
    </div>
  )
}

interface InaccessibleMountBannerProps {
  entry: InaccessibleMountCandidate
  onRetry: () => void
}

// Shown for a candidate the server found but could not READ (permission
// denied) -- a different, actionable problem from "nothing mounted here".
// No "Add" action: nothing here can be turned into a profile until the
// underlying permission is fixed, so the only useful next step is to fix it
// (outside the panel) and retry the scan.
export function InaccessibleMountBanner({ entry, onRetry }: InaccessibleMountBannerProps) {
  const [dismissed, setDismissed] = useState(() => isDismissed(entry.path))
  if (dismissed) return null

  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(entry.path), 'true')
    } catch {
      /* ignore storage failures */
    }
    setDismissed(true)
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/[0.06] px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <span className="text-sm font-medium">
          {bannerFallback('foundUnreadableTitle', 'Found something here, but could not read it')}
        </span>
        <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={entry.path}>
          {entry.path}
        </code>
      </div>
      <span className="text-xs text-muted-foreground">
        {entry.reason || bannerFallback(
          'foundUnreadableDesc',
          'This looks like the right folder, but the panel does not have permission to read it. On Unraid, check the PUID/PGID on this container match the folder owner.',
        )}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={dismiss} aria-label="Dismiss" title="Dismiss">
          <X className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {bannerFallback('retryScan', 'Retry')}
        </Button>
      </div>
    </div>
  )
}
