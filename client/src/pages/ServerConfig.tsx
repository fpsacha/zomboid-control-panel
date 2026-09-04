import { useState, useEffect, useMemo, useCallback, useRef, useDeferredValue, memo } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useSearchParams, Link } from 'react-router-dom'
import { copyText, cn } from '@/lib/utils'
import {
  Settings,
  FileText,
  MapPin,
  Map,
  Save,
  RefreshCw,
  Search,
  Code,
  FormInput,
  Puzzle,
  Loader2,
  CheckCircle,
  AlertCircle,
  History,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Plus,
  Trash2,
  ExternalLink,
  Download,
  Upload,
  RotateCcw,
  AlertTriangle,
  Info,
  Copy,
  Check,
  Filter,
  Bookmark,
  FolderOpen,
  X,
  Undo2,
  Globe,
  Swords,
  MessageSquare,
  Users,
  Home,
  Package,
  Cloud,
  Mic,
  MessageCircle,
  Terminal,
  Archive,
  Car,
  Shield,
  Wrench,
  Radio,
  Clock,
  Gem,
  Heart,
  Crosshair,
  Leaf,
  Compass,
  Skull,
  TrendingUp,
  BarChart,
  Layers,
  type LucideIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { reportClientError } from '@/lib/client-errors'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { HelpTip } from '@/components/HelpTip'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/components/ui/use-toast'
import { useConfirm } from '@/contexts/ConfirmContext'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
// AlertDialog imports available if needed for save confirmation
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { PageHeader } from '@/components/PageHeader'
// DropdownMenu imports available if needed
import { serverApi, serverFilesApi, serversApi, panelBridgeApi, ApiError, SpawnPointsByProfession, SpawnRegion, SandboxData, ConfigTemplate } from '@/lib/api'
import { resolveServerRunning } from '@/lib/serverStatus'
import { getBridgeVerifiedState } from '@/lib/bridgeVerify'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { formatModSettingDescription, formatModSettingLabel } from '@/lib/modSettingsLabels'
import { EmptyState } from '@/components/EmptyState'
import { useAuth } from '@/contexts/AuthContext'
import { DisabledReason } from '@/components/DisabledReason'
import {
  INI_SCHEMA,
  INI_CATEGORIES,
  INI_CATEGORY_GROUPS,
  SANDBOX_SCHEMA,
  SANDBOX_CATEGORIES,
  SANDBOX_CATEGORY_GROUPS,
  normalizeNumericInput,
  parseNumericSettingValue,
  IniSetting,
  SandboxSetting,
  groupByCategory,
  getIniSettingLabel,
  getIniSettingDescription,
  getIniSettingOptionLabel,
  getIniSettingSearchText,
  getIniCategoryLabel,
  getIniCategoryGroupLabel,
  getSandboxSettingLabel,
  getSandboxSettingDescription,
  getSandboxSettingOptionLabel,
  getSandboxSettingSearchText,
  getSandboxCategoryLabel,
  getSandboxCategoryGroupLabel,
  getUnrecognizedSandboxOptionWarning,
  formatRawConfigValue,
} from '@/lib/serverConfigSchema'

type EditorMode = 'structured' | 'raw'
type FilterMode = 'all' | 'modified' | 'nondefault'
type SandboxScalar = string | number | boolean | null | undefined
type SandboxRecord = Record<string, SandboxScalar>

// PanelBridge enumerates every sandbox option. These are Project Zomboid's
// built-in groups, which belong in the Sandbox editor rather than Mod Settings.
const VANILLA_SANDBOX_GROUPS = new Set([
  'Vanilla',
  'Map',
  'ZombieLore',
  'ZombieConfig',
  'MultiplierConfig',
  'Basement',
])

// These were shown by older panel releases but Build 42 does not support them.
const UNSUPPORTED_INI_KEYS = new Set([
  'ServerImageLoginScreen',
  'ServerImageLoadingScreen',
  'ServerImageIcon',
])

/** Merge schema defaults into parsed INI settings so schema-defined keys always exist.
 *  Also warns to the console when a stored value doesn't parse for the schema type — helps
 *  catch a corrupted INI without changing behaviour. */
function mergeSchemaDefaults(parsed: Record<string, string>): Record<string, string> {
  const merged = { ...parsed }
  for (const setting of INI_SCHEMA) {
    if (!(setting.key in merged)) {
      merged[setting.key] = String(setting.default ?? '')
      continue
    }
    const raw = merged[setting.key]
    if (raw == null || raw === '') continue
    if (setting.type === 'boolean' && raw !== 'true' && raw !== 'false') {
      console.warn(`[ServerConfig] ${setting.key} expected boolean, got "${raw}"`)
    } else if (setting.type === 'number' && Number.isNaN(Number(raw))) {
      console.warn(`[ServerConfig] ${setting.key} expected number, got "${raw}"`)
    } else if (setting.type === 'select' && setting.options && !setting.options.some(o => o.value === raw)) {
      console.warn(`[ServerConfig] ${setting.key} expected one of [${setting.options.map(o => o.value).join('|')}], got "${raw}"`)
    }
  }
  return merged
}

function createSandboxDefaults(): SandboxData {
  const sandbox: SandboxData = {
    VERSION: 4,
    settings: {},
    ZombieLore: {},
    ZombieConfig: {},
    MultiplierConfig: {},
    Map: {},
    Basement: {},
  }
  for (const setting of SANDBOX_SCHEMA) {
    const section = (setting.section || 'settings') as keyof SandboxData
    const values = sandbox[section]
    if (typeof values === 'object' && values !== null) {
      values[setting.key] = setting.default ?? ''
    }
  }
  return sandbox
}

// PanelBridge.lua's setSandboxOption handler calls world:saveWorld() to make
// a live sandbox-option change durable, and reports the result as
// `persisted`/`saveError` (commit b376b2c) -- added specifically because a
// bare pcall used to swallow a failed world save and report success either
// way. persisted===false is a real failure the mod already detected and
// logged server-side; `undefined` means an older bridge build that never
// sends this field at all and must NOT be read as a failure -- same
// old-bridge-safe contract as getBridgeVerifiedState (lib/bridgeVerify.ts)
// applies to `verified`. Exported as a pure predicate so this exact
// contract (only an explicit false warns) is unit-testable without
// mounting the whole page.
export function isWorldSaveFailure(data: { persisted?: unknown } | null | undefined): boolean {
  return data?.persisted === false
}

// server/routes/serverFiles.js's POST /templates/:id/apply tracks each write
// as it actually lands, and attaches that as `partiallyApplied` on the 500
// body when INI succeeded before Sandbox threw (the two settings groups are
// written independently, so one can land while the other fails).
// ApiError.data carries the raw response payload -- read it here rather than
// showing a generic failure that would read as "nothing happened" when part
// of the template is now live on disk. Exported as a pure predicate so the
// decision (partial-apply toast vs. generic failure toast) is unit-testable
// without mounting the whole page.
export function getPartiallyAppliedFromApplyTemplateError(error: unknown): string[] | null {
  if (
    error instanceof ApiError &&
    error.data &&
    typeof error.data === 'object' &&
    Array.isArray((error.data as { partiallyApplied?: unknown }).partiallyApplied)
  ) {
    const applied = (error.data as { partiallyApplied: string[] }).partiallyApplied
    return applied.length > 0 ? applied : null
  }
  return null
}

// Auth-aware image preview (img tags can't send Bearer tokens)
function AuthImage({ filePath, alt, className }: { filePath: string; alt?: string; className?: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const blobRef = useRef<string | null>(null)
  useEffect(() => {
    if (!filePath) return
    let cancelled = false
    serverFilesApi.fetchImagePreview(filePath).then(url => {
      if (cancelled) { URL.revokeObjectURL(url); return }
      if (blobRef.current) URL.revokeObjectURL(blobRef.current)
      blobRef.current = url
      setBlobUrl(url)
    }).catch(() => {})
    return () => {
      cancelled = true
      if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null }
    }
  }, [filePath])
  if (!blobUrl) return null
  return <img src={blobUrl} alt={alt || 'Preview'} className={className} />
}

// --- Optimized Row Components ---

const IniSettingRow = memo(({
  setting,
  value,
  originalValue,
  onChange,
  onReset,
  onBrowse
}: {
  setting: IniSetting;
  value: string;
  originalValue?: string;
  onChange: (key: string, value: string) => void;
  onReset?: (key: string) => void;
  onBrowse?: (key: string, extensions?: string[]) => void;
}) => {
  const { t } = useTranslation('serverconfig')
  const isModified = originalValue !== undefined && value !== originalValue
  const isDifferentFromDefault = setting.default !== undefined && String(value) !== String(setting.default)
  const numberIsInvalid = setting.type === 'number' && String(value ?? '').trim() !== '' && parseNumericSettingValue(value, setting) === null

  // Multiline settings
  if (setting.type === 'multiline') {
    return (
      <div className={`perf-content-auto grid gap-2 rounded-md border-b py-3 ps-3 pe-4 transition-colors last:border-0 ${
        isModified ? 'border-s-2 border-s-warning bg-warning/5' : 'border-s-2 border-s-transparent hover:bg-muted/20'
      }`}>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">{getIniSettingLabel(setting)}</Label>
            <p className="text-xs text-muted-foreground mt-0.5">{getIniSettingDescription(setting)}</p>
          </div>
          {isModified && onReset && (
            <Button variant="ghost" size="sm" className="h-7 text-xs text-warning hover:text-warning" onClick={() => onReset(setting.key)}>
              <Undo2 className="w-3 h-3 me-1" /> {t('row.reset')}
            </Button>
          )}
        </div>
        <Textarea
          value={value}
          onChange={(e) => onChange(setting.key, e.target.value)}
          className={`min-h-[80px] resize-y ${isModified ? 'border-warning/40' : ''}`}
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <code className="bg-muted px-1 rounded">{setting.key}</code>
          {setting.default !== undefined && (
            <span className={isDifferentFromDefault ? 'text-warning' : ''}>{t('row.defaultValue', { value: formatRawConfigValue(setting.default) })}</span>
          )}
        </div>
      </div>
    )
  }

  // Standard settings
  return (
    <div className={`perf-content-auto grid gap-2 rounded-md border-b py-3 ps-3 pe-4 transition-colors last:border-0 ${
      isModified ? 'border-s-2 border-s-warning bg-warning/5' : 'border-s-2 border-s-transparent hover:bg-muted/20'
    }`}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">{getIniSettingLabel(setting)}</Label>
            {isModified && (
              <Badge variant="warning" className="h-5 text-xs">{t('row.modifiedBadge')}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">{getIniSettingDescription(setting)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isModified && onReset && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-11 w-11 text-warning hover:text-warning sm:h-9 sm:w-9" onClick={() => onReset(setting.key)} aria-label={t('row.resetAria', { label: getIniSettingLabel(setting) })}>
                    <Undo2 className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('row.resetToLoadedValue')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <div className={`w-full ${setting.type === 'filepath' ? 'sm:w-72' : 'sm:w-48'}`}>
            {setting.type === 'boolean' ? (
              <div className="flex items-center gap-2 justify-end">
                <span className="text-xs text-muted-foreground">{String(value).toLowerCase() === 'true' ? t('row.on') : t('row.off')}</span>
                <Switch
                  checked={String(value).toLowerCase() === 'true'}
                  onCheckedChange={(checked) => onChange(setting.key, checked ? 'true' : 'false')}
                  aria-label={getIniSettingLabel(setting) || setting.key}
                />
              </div>
            ) : setting.type === 'select' && setting.options ? (
              <Select value={String(value)} onValueChange={(val) => onChange(setting.key, val)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {setting.options.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{getIniSettingOptionLabel(setting, opt.value)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : setting.type === 'number' ? (
              <div>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => {
                    onChange(setting.key, normalizeNumericInput(e.target.value))
                  }}
                  min={setting.min}
                  max={setting.max}
                  aria-invalid={numberIsInvalid}
                  className={`text-end ${isModified ? 'border-warning/40' : ''} ${numberIsInvalid ? 'border-destructive/70' : ''}`}
                />
                {(setting.min !== undefined || setting.max !== undefined) && (
                  <div className="text-xs text-muted-foreground/60 text-end mt-0.5">
                    {setting.min !== undefined && setting.max !== undefined
                      ? t('row.rangeMinMax', { min: setting.min, max: setting.max })
                      : setting.min !== undefined
                      ? t('row.rangeMin', { min: setting.min })
                      : t('row.rangeMax', { max: setting.max })}
                  </div>
                )}
              </div>
            ) : setting.type === 'filepath' ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Input
                    value={String(value)}
                    onChange={(e) => onChange(setting.key, e.target.value)}
                    className={`flex-1 font-mono text-xs ${isModified ? 'border-warning/40' : ''}`}
                    placeholder={t('fileBrowserDialog.noImageSelected')}
                    maxLength={512}
                  />
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => onBrowse?.(setting.key, setting.fileExtensions)} aria-label={t('fileBrowserDialog.browseAria')}>
                          <FolderOpen className="w-3.5 h-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('fileBrowserDialog.browseTooltip')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  {value && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => onChange(setting.key, '')} aria-label={t('fileBrowserDialog.clearImageAria')}>
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('fileBrowserDialog.clearImageTooltip')}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
                {value && (
                  <div className="rounded-md border bg-muted/30 p-1.5 max-w-[200px]">
                    <AuthImage
                      filePath={value}
                      alt={getIniSettingLabel(setting)}
                      className="rounded max-h-[80px] w-auto object-contain"
                    />
                  </div>
                )}
              </div>
            ) : (
              <Input
                value={String(value)}
                onChange={(e) => onChange(setting.key, e.target.value)}
                className={isModified ? 'border-warning/40' : ''}
                maxLength={512}
              />
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <code className="bg-muted px-1 rounded">{setting.key}</code>
        {setting.default !== undefined && (
          <span className={isDifferentFromDefault ? 'text-warning' : ''}>{t('row.defaultValue', { value: formatRawConfigValue(setting.default) })}</span>
        )}
      </div>
    </div>
  )
}, (prev, next) => {
  return prev.value === next.value && prev.setting === next.setting && prev.originalValue === next.originalValue && prev.onBrowse === next.onBrowse
})
IniSettingRow.displayName = 'IniSettingRow'

export const SandboxSettingRow = memo(({
  setting,
  value,
  originalValue,
  onChange,
  onReset
}: {
  setting: SandboxSetting;
  value: SandboxScalar;
  originalValue?: SandboxScalar;
  onChange: (setting: SandboxSetting, value: SandboxScalar) => void;
  onReset?: (setting: SandboxSetting) => void;
}) => {
  const { t } = useTranslation('serverconfig')
  const isModified = originalValue !== undefined && JSON.stringify(value) !== JSON.stringify(originalValue)
  const isDifferentFromDefault = setting.default !== undefined && JSON.stringify(value) !== JSON.stringify(setting.default)
  const numberIsInvalid = setting.type === 'number' && String(value ?? '').trim() !== '' && parseNumericSettingValue(value, setting) === null
  // A live value with no matching option -- PZ shipped a value this panel's
  // schema doesn't know (the class of bug the enum audit found: MetaEvent=3
  // when the panel only offered 1-2). The save path never coerces this (see
  // the audit report), so the value itself is safe -- this is purely making
  // that visible instead of rendering a blank Select.
  const hasUnrecognizedValue =
    setting.type === 'select' &&
    !!setting.options &&
    value !== undefined &&
    value !== null &&
    value !== '' &&
    !setting.options.some((o) => o.value === Number(value))

  return (
    <div className={`perf-content-auto grid gap-2 rounded-md border-b py-3 ps-3 pe-4 transition-colors last:border-0 ${
      isModified ? 'border-s-2 border-s-warning bg-warning/5' : 'border-s-2 border-s-transparent hover:bg-muted/20'
    }`}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Label className="text-sm font-medium">{getSandboxSettingLabel(setting)}</Label>
            {isModified && (
              <Badge variant="warning" className="h-5 text-xs">{t('row.modifiedBadge')}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">{getSandboxSettingDescription(setting)}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
            <code className="bg-muted px-1 rounded">{setting.key}</code>
            {setting.default !== undefined && (
              <span className={isDifferentFromDefault ? 'text-warning' : ''}>{t('row.defaultValue', { value: formatRawConfigValue(setting.default) })}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isModified && onReset && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-11 w-11 text-warning hover:text-warning sm:h-9 sm:w-9" onClick={() => onReset(setting)} aria-label={t('row.resetAria', { label: getSandboxSettingLabel(setting) })}>
                    <Undo2 className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('row.resetToLoadedValue')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <div className="w-full sm:w-48">
            {setting.type === 'boolean' ? (
              <div className="flex items-center gap-2 justify-end">
                <span className="text-xs text-muted-foreground">{Boolean(value) ? t('row.on') : t('row.off')}</span>
                <Switch
                  checked={Boolean(value)}
                  onCheckedChange={(checked) => onChange(setting, checked)}
                  aria-label={getSandboxSettingLabel(setting) || setting.key}
                />
              </div>
            ) : setting.type === 'select' && setting.options ? (
              <div>
                <Select value={String(value || '')} onValueChange={(v) => onChange(setting, Number(v))}>
                  <SelectTrigger className={hasUnrecognizedValue ? 'border-warning/60' : ''}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {hasUnrecognizedValue && (
                      <SelectItem value={String(value)} disabled>
                        {String(value)} (?)
                      </SelectItem>
                    )}
                    {setting.options.map(opt => (
                      <SelectItem key={opt.value} value={String(opt.value)}>{getSandboxSettingOptionLabel(setting, opt.value)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {hasUnrecognizedValue && (
                  <div className="flex items-start gap-1.5 mt-1.5 text-xs text-warning">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{getUnrecognizedSandboxOptionWarning(String(value))}</span>
                  </div>
                )}
              </div>
            ) : setting.type === 'string' ? (
              // GH#143: a plain text input, no numeric coercion. This used
              // to fall into the numeric branch below (the catch-all had no
              // type === 'string' gate), so every comma the user typed into
              // a comma-separated list (WorldItemRemovalList,
              // LootItemRemovalList -- the only two sandbox settings with
              // type: 'string') got silently turned into a period by
              // normalizeNumericInput(), including on paste. A third string
              // setting added later lands here too rather than silently
              // inheriting the numeric branch.
              <Input
                type="text"
                value={value !== undefined ? String(value) : ''}
                onChange={(e) => onChange(setting, e.target.value)}
                className={isModified ? 'border-warning/40' : ''}
              />
            ) : (
              <div>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={value !== undefined ? String(value) : ''}
                  onChange={(e) => onChange(setting, normalizeNumericInput(e.target.value))}
                  min={setting.min}
                  max={setting.max}
                  step={setting.max && setting.max <= 1 ? 0.1 : 1}
                  aria-invalid={numberIsInvalid}
                  className={`text-end ${isModified ? 'border-warning/40' : ''} ${numberIsInvalid ? 'border-destructive/70' : ''}`}
                />
                {(setting.min !== undefined || setting.max !== undefined) && (
                  <div className="text-xs text-muted-foreground/60 text-end mt-0.5">
                    {setting.min !== undefined && setting.max !== undefined
                      ? t('row.rangeMinMax', { min: setting.min, max: setting.max })
                      : setting.min !== undefined
                      ? t('row.rangeMin', { min: setting.min })
                      : t('row.rangeMax', { max: setting.max })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}, (prev, next) => {
  return prev.value === next.value && prev.setting === next.setting && prev.originalValue === next.originalValue
})
SandboxSettingRow.displayName = 'SandboxSettingRow'

function StatChip({
  icon,
  value,
  label,
  ok,
}: {
  icon: React.ReactNode
  value: string | number
  label: string
  ok?: boolean
}) {
  const { t } = useTranslation('serverconfig')
  const numericValue = typeof value === 'number' ? value : Number(value)
  const isZero = !Number.isNaN(numericValue) && numericValue === 0
  const muted = isZero || ok === false
  return (
    <span
      className={`inline-flex items-center gap-1.5 normal-case tracking-normal ${muted ? 'opacity-55' : ''}`}
      title={ok === false ? t('activeServerStrip.fileNotFoundTitle', { label }) : undefined}
    >
      <span className={muted ? 'text-muted-foreground/50' : 'text-primary/70'}>{icon}</span>
      <span className={`font-mono text-sm font-semibold tabular-nums ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
      {ok === false && (
        <AlertCircle className="h-3 w-3 text-warning" aria-label={t('activeServerStrip.notFoundAria')} />
      )}
    </span>
  )
}

// Map of icon names used by INI/Sandbox category schemas to lucide components.
// Each entry also has a hue token used to subtly tint the sidebar icon so categories
// are scannable by shape+color without going neon.
const CATEGORY_ICONS: Record<string, { icon: LucideIcon; tone: string }> = {
  // INI categories
  Settings: { icon: Settings, tone: 'text-primary/80' },
  Globe: { icon: Globe, tone: 'text-sky-400/80' },
  Swords: { icon: Swords, tone: 'text-rose-400/80' },
  MessageSquare: { icon: MessageSquare, tone: 'text-cyan-400/80' },
  Users: { icon: Users, tone: 'text-amber-300/80' },
  Home: { icon: Home, tone: 'text-emerald-300/80' },
  Package: { icon: Package, tone: 'text-orange-300/80' },
  Puzzle: { icon: Puzzle, tone: 'text-violet-400/80' },
  Cloud: { icon: Cloud, tone: 'text-sky-300/80' },
  Mic: { icon: Mic, tone: 'text-pink-300/80' },
  MessageCircle: { icon: MessageCircle, tone: 'text-indigo-300/80' },
  Terminal: { icon: Terminal, tone: 'text-emerald-400/80' },
  Archive: { icon: Archive, tone: 'text-amber-400/80' },
  Car: { icon: Car, tone: 'text-yellow-300/80' },
  Shield: { icon: Shield, tone: 'text-blue-300/80' },
  Filter: { icon: Filter, tone: 'text-slate-300/80' },
  Radio: { icon: Radio, tone: 'text-fuchsia-300/80' },
  FileText: { icon: FileText, tone: 'text-zinc-300/80' },
  Wrench: { icon: Wrench, tone: 'text-stone-300/80' },
  // Sandbox categories
  Clock: { icon: Clock, tone: 'text-amber-300/80' },
  Gem: { icon: Gem, tone: 'text-fuchsia-300/80' },
  Heart: { icon: Heart, tone: 'text-rose-300/80' },
  Crosshair: { icon: Crosshair, tone: 'text-rose-400/80' },
  Leaf: { icon: Leaf, tone: 'text-emerald-300/80' },
  Map: { icon: Map, tone: 'text-emerald-400/80' },
  Compass: { icon: Compass, tone: 'text-cyan-300/80' },
  Skull: { icon: Skull, tone: 'text-rose-300/80' },
  TrendingUp: { icon: TrendingUp, tone: 'text-orange-300/80' },
  BarChart: { icon: BarChart, tone: 'text-amber-300/80' },
  Layers: { icon: Layers, tone: 'text-stone-300/80' },
}

function CategoryIcon({ name, isActive, className }: { name?: string; isActive?: boolean; className?: string }) {
  const entry = name ? CATEGORY_ICONS[name] : undefined
  const Icon = entry?.icon ?? Settings
  return <Icon className={`${className ?? 'h-4 w-4'} ${isActive ? 'text-primary' : entry?.tone ?? 'text-muted-foreground/70'}`} />
}

// ──────────────────────────────────────────────────────────────────────────
// Visual primitives — mirror the Events page so the whole control surface
// reads with the same cadence.
// ──────────────────────────────────────────────────────────────────────────
type PanelTone = 'primary' | 'warning' | 'destructive' | 'info' | 'success' | 'muted'

function toneBorder(tone: PanelTone): string {
  switch (tone) {
    case 'warning': return 'border-amber-400/55'
    case 'destructive': return 'border-destructive/55'
    case 'info': return 'border-sky-400/55'
    case 'success': return 'border-emerald-400/55'
    case 'muted': return 'border-border/70'
    default: return 'border-primary/55'
  }
}

function toneText(tone: PanelTone): string {
  switch (tone) {
    case 'warning': return 'text-amber-400/85'
    case 'destructive': return 'text-destructive/85'
    case 'info': return 'text-sky-400/85'
    case 'success': return 'text-emerald-400/85'
    case 'muted': return 'text-muted-foreground/85'
    default: return 'text-primary/75'
  }
}

function TacticalPanel({
  children,
  tone = 'primary',
  className,
}: {
  children: React.ReactNode
  tone?: PanelTone
  className?: string
}) {
  return (
    <div className={cn(
      'overflow-hidden rounded-md border bg-card shadow-sm',
      toneBorder(tone),
      className
    )}>
      {children}
    </div>
  )
}

export function SectionHeader({
  label,
  sublabel,
  icon: Icon,
  action,
  tone = 'primary',
}: {
  label: string
  sublabel?: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
  action?: React.ReactNode
  tone?: PanelTone
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3 select-none">
      <span className="flex min-w-0 items-center gap-2">
        {Icon && <Icon className={cn('h-4 w-4 shrink-0', toneText(tone))} />}
        <span className="truncate text-sm font-semibold text-foreground">{label}</span>
        {sublabel && (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-muted-foreground/35">/</span>
            <span className="truncate text-xs font-normal text-muted-foreground/65">{sublabel}</span>
          </span>
        )}
      </span>
      {action && <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:shrink-0">{action}</div>}
    </div>
  )
}

const SERVER_CONFIG_TABS = new Set(['ini', 'sandbox', 'spawnpoints', 'spawnregions', 'modsettings'])

// Closed enum matching server/routes/debug.js's triageUnresolvedMods -- an
// unrecognized cause (an older diagnostics fetch predating this, or a value
// this build doesn't know yet) is dropped rather than trusted, same
// defensive stance Debug.tsx takes reading the same querystring value.
export type UnresolvedModCause = 'typo' | 'stillDownloading' | 'workshopNotOnDisk' | 'absent'
const UNRESOLVED_MOD_CAUSES = new Set<UnresolvedModCause>(['typo', 'stillDownloading', 'workshopNotOnDisk', 'absent'])

export function resolveServerConfigDeepLink(searchParams: URLSearchParams) {
  const requestedTab = searchParams.get('tab')
  const unresolved = searchParams.getAll('unresolved')
    .map((modId) => modId.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 20)
  const unresolvedIds = new Set(unresolved)
  // One `modId|cause|suggestion` entry per triaged ID (Debug.tsx's own
  // transport, see getDiagnosticsFixAction's mods.resolved case) -- only
  // trust an entry whose modId is actually in `unresolved` above, so a
  // hand-edited URL can't attach an arbitrary cause to an ID the diagnostics
  // check never flagged.
  // `Map` above 20 lines up is lucide-react's icon component, not the
  // built-in collection -- globalThis.Map dodges that shadowing.
  const unresolvedTriage = new globalThis.Map<string, { cause: UnresolvedModCause; suggestion?: string }>()
  for (const raw of searchParams.getAll('unresolvedCause').slice(0, 20)) {
    const [modId, cause, suggestion] = raw.split('|')
    if (!modId || !unresolvedIds.has(modId)) continue
    if (!UNRESOLVED_MOD_CAUSES.has(cause as UnresolvedModCause)) continue
    unresolvedTriage.set(modId, {
      cause: cause as UnresolvedModCause,
      ...(suggestion ? { suggestion: suggestion.trim().slice(0, 120) } : {}),
    })
  }
  return {
    tab: requestedTab && SERVER_CONFIG_TABS.has(requestedTab) ? requestedTab : 'ini',
    search: (searchParams.get('search') || '').trim().slice(0, 100),
    unresolved,
    unresolvedTriage,
  }
}

export default function ServerConfig() {
  const { t, i18n } = useTranslation('serverconfig')
  const searchLocale = i18n.resolvedLanguage || i18n.language
  const [searchParams] = useSearchParams()
  const initialDeepLink = resolveServerConfigDeepLink(searchParams)
  // List separator is a language property, not something a joined list of
  // translated setting labels can be assumed to want a Latin ", " for --
  // zh-CN / zh-TW enumerates nouns with the ideographic comma instead.
  const listSep = i18n.language.startsWith('zh') ? '、' : ', '
  const [activeTab, setActiveTab] = useState(initialDeepLink.tab)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [serverRunning, setServerRunning] = useState<boolean | null>(null)
  const [searchQuery, setSearchQuery] = useState(initialDeepLink.search)
  // Defer the search value so each keystroke doesn't re-filter the full schema
  // synchronously — keeps the input snappy on slower machines.
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const [editorMode, setEditorMode] = useState<EditorMode>('structured')
  // Filter mode: 'all' = every schema setting, 'modified' = differs from the PZ default,
  // 'nondefault' = local edits not yet saved.
  const [filterMode, setFilterMode] = useState<FilterMode>(() => {
    if (initialDeepLink.search) return 'all'
    try {
      const stored = localStorage.getItem('serverconfig-filter-mode')
      // Before this migration, "nondefault" represented settings changed from PZ defaults.
      if (stored === 'nondefault') return 'modified'
      if (stored === 'modified' || stored === 'nondefault' || stored === 'all') return stored
    } catch { /* ignore */ }
    return 'all'
  })
  useEffect(() => { try { localStorage.setItem('serverconfig-filter-mode', filterMode) } catch { /* ignore */ } }, [filterMode])

  // File paths info
  const [pathsInfo, setPathsInfo] = useState<{
    configPath: string
    serverName: string
    exists: { ini: boolean; sandbox: boolean; spawnpoints: boolean; spawnregions: boolean }
  } | null>(null)

  // Data states
  const [iniSettings, setIniSettings] = useState<Record<string, string>>({})
  const [sandboxData, setSandboxData] = useState<SandboxData | null>(null)
  const [spawnPoints, setSpawnPoints] = useState<SpawnPointsByProfession>({})
  const [spawnRegions, setSpawnRegions] = useState<SpawnRegion[]>([])
  // GET /server-files/ini already detects this server-side (utils/
  // iniDuplicateKeys.js) -- same signal Mods.tsx's own duplicateKeys
  // warning reads from GET /mods/current-config, just never wired up here.
  // parseIni()'s line-by-line loop lets the LAST occurrence win, so
  // iniSettings above silently reflects that one; this state is only for
  // telling the operator the file has more than one candidate value.
  const [duplicateKeys, setDuplicateKeys] = useState<Array<{ key: string; count: number }>>([])

  // Raw content for raw editing mode
  const [rawContent, setRawContent] = useState('')

  // Active category in the vertical rail (one-at-a-time, tab-style)
  const [activeIniCategory, setActiveIniCategory] = useState<string>(() => {
    try { return localStorage.getItem('serverconfig-ini-cat') || 'general' } catch { return 'general' }
  })
  const [activeSandboxCategory, setActiveSandboxCategory] = useState<string>(() => {
    try { return localStorage.getItem('serverconfig-sandbox-cat') || 'time' } catch { return 'time' }
  })
  useEffect(() => { try { localStorage.setItem('serverconfig-ini-cat', activeIniCategory) } catch { /* ignore */ } }, [activeIniCategory])
  useEffect(() => { try { localStorage.setItem('serverconfig-sandbox-cat', activeSandboxCategory) } catch { /* ignore */ } }, [activeSandboxCategory])

  // Collapsible rail groups — keyed as "ini:<groupId>" / "sandbox:<groupId>"
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem('serverconfig-collapsed-groups')
      if (stored) return JSON.parse(stored) as Record<string, boolean>
    } catch { /* ignore */ }
    return {}
  })
  useEffect(() => {
    try { localStorage.setItem('serverconfig-collapsed-groups', JSON.stringify(collapsedGroups)) } catch { /* ignore */ }
  }, [collapsedGroups])
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups(prev => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // Bulk collapse/expand for a tab's rail (prefix "ini" or "sandbox").
  const setAllGroupsCollapsed = useCallback((prefix: 'ini' | 'sandbox', collapsed: boolean) => {
    const groups = prefix === 'ini' ? INI_CATEGORY_GROUPS : SANDBOX_CATEGORY_GROUPS
    setCollapsedGroups(prev => {
      const next = { ...prev }
      for (const g of groups) {
        next[`${prefix}:${g.id}`] = collapsed
      }
      return next
    })
  }, [])
  const iniAllCollapsed = useMemo(
    () => INI_CATEGORY_GROUPS.every(g => !!collapsedGroups[`ini:${g.id}`]),
    [collapsedGroups]
  )
  const sandboxAllCollapsed = useMemo(
    () => SANDBOX_CATEGORY_GROUPS.every(g => !!collapsedGroups[`sandbox:${g.id}`]),
    [collapsedGroups]
  )

  // Backups dialog
  const [showBackups, setShowBackups] = useState(false)
  const [backups, setBackups] = useState<{ filename: string; size: number; created: string }[]>([])
  const [backupFilter, setBackupFilter] = useState<'all' | 'ini' | 'sandbox' | 'spawnpoints' | 'spawnregions'>('all')

  // Templates dialog
  const [showTemplates, setShowTemplates] = useState(false)
  const [templates, setTemplates] = useState<ConfigTemplate[]>([])
  const [templateLoading, setTemplateLoading] = useState(false)
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [newTemplateDesc, setNewTemplateDesc] = useState('')
  const [saveTemplateIni, setSaveTemplateIni] = useState(true)
  const [saveTemplateSandbox, setSaveTemplateSandbox] = useState(true)

  // Track original data for change detection
  const [originalIniSettings, setOriginalIniSettings] = useState<Record<string, string>>({})
  const [originalSandboxData, setOriginalSandboxData] = useState<SandboxData | null>(null)
  const [originalRawContent, setOriginalRawContent] = useState('')

  const invalidIniSettings = useMemo(
    () => INI_SCHEMA.filter(setting => {
      if (setting.type !== 'number') return false
      const value = iniSettings[setting.key]
      return String(value ?? '').trim() !== '' && parseNumericSettingValue(value, setting) === null
    }),
    [iniSettings],
  )

  const invalidSandboxSettings = useMemo(() => {
    if (!sandboxData) return []
    return SANDBOX_SCHEMA.filter(setting => {
      if (setting.type !== 'number') return false
      const section = (setting.section || 'settings') as keyof SandboxData
      const value = (sandboxData[section] as SandboxRecord | undefined)?.[setting.key]
      return value !== undefined && value !== null && String(value).trim() !== '' && parseNumericSettingValue(value, setting) === null
    })
  }, [sandboxData])

  // Mod Settings (live from PanelBridge)
  const [modSettings, setModSettings] = useState<Record<string, Array<{
    name?: string; shortName?: string; tableName?: string; value?: unknown;
    type?: string; min?: number; max?: number; default?: unknown;
    enumValues?: string[]; selectedIndex?: number; translatedName?: string;
    tooltip?: string; tooltipText?: string; pageName?: string;
  }>> | null>(null)
  const [modSettingsGroups, setModSettingsGroups] = useState<Array<{ name: string; count: number }>>([])
  const [modSettingsLoading, setModSettingsLoading] = useState(false)
  const [modSettingsError, setModSettingsError] = useState<string | null>(null)
  const [modSettingsSearch, setModSettingsSearch] = useState('')
  const [modSettingsModifiedOnly, setModSettingsModifiedOnly] = useState(false)
  const [expandedModGroups, setExpandedModGroups] = useState<Set<string>>(new Set())
  const [modSettingsLastLoaded, setModSettingsLastLoaded] = useState<Date | null>(null)
  // Generation counter, not an AbortController -- panelBridgeApi.sendCommand
  // has no signal option to cancel the in-flight request, so the previous
  // AbortController here aborted nothing and its signal was never even
  // passed to sendCommand. Two Refresh clicks close together used to race:
  // whichever response landed last (not last-requested) won, silently.
  const modSettingsLoadIdRef = useRef(0)
  const modSettingsSearchRef = useRef<HTMLInputElement | null>(null)
  const iniSearchRef = useRef<HTMLInputElement | null>(null)
  const sandboxSearchRef = useRef<HTMLInputElement | null>(null)
  const [savingOptions, setSavingOptions] = useState<Set<string>>(new Set())

  // Shared helper: is this mod option modified from its default?
  const isOptModified = useCallback((opt: { default?: unknown; value?: unknown }) => {
    if (opt.default === undefined || opt.default === null) return false
    const d = opt.default, v = opt.value
    if (typeof d === 'number' && typeof v === 'number') return Math.abs(d - v) >= 0.0001
    return String(d) !== String(v)
  }, [])

  // Total count of modified mod options across all groups
  const modifiedModSettingsCount = useMemo(() => {
    if (!modSettings) return 0
    let c = 0
    for (const opts of Object.values(modSettings)) {
      for (const o of opts) if (isOptModified(o)) c++
    }
    return c
  }, [modSettings, isOptModified])

  // Memoize filtered mod settings groups to avoid duplicate filter logic
  const filteredModGroups = useMemo(() => {
    if (!modSettings || !modSettingsGroups.length) return []
    const q = modSettingsSearch.toLowerCase().trim()
    return modSettingsGroups
      .map(group => {
        let opts = modSettings[group.name] || []
        if (modSettingsModifiedOnly) opts = opts.filter(isOptModified)
        if (q) {
          const groupMatches = formatModSettingLabel(group.name).toLowerCase().includes(q)
          if (!groupMatches) {
            opts = opts.filter(o =>
              (o.name || '').toLowerCase().includes(q) ||
              (o.shortName || '').toLowerCase().includes(q) ||
              (o.translatedName || '').toLowerCase().includes(q) ||
              formatModSettingLabel(o.translatedName || o.shortName || o.name, group.name).toLowerCase().includes(q) ||
              (o.tooltip || '').toLowerCase().includes(q) ||
              (o.tooltipText || '').toLowerCase().includes(q)
            )
          }
        }
        return { ...group, filteredOpts: opts }
      })
      .filter(g => g.filteredOpts.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [modSettings, modSettingsGroups, modSettingsSearch, modSettingsModifiedOnly, isOptModified])

  // Copy state
  const [copied, setCopied] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Active server context, read independently of the (possibly-failed) paths
  // load below -- server/routes/serverFiles.js's getServerConfigPath() falls
  // through a remote server with no SFTP transport configured to the same
  // ServerNotConfiguredError a genuinely-unconfigured panel throws, so the
  // wire error code alone can't tell "no active server" apart from "active
  // server is remote and isn't set up for config editing". Same
  // isRemote-flag-fetched-independently pattern as Backups.tsx.
  const [activeServerRemote, setActiveServerRemote] = useState(false)
  const [activeServerName, setActiveServerName] = useState<string | null>(null)

  // File browser state (for image path fields)
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false)
  const [fileBrowserKey, setFileBrowserKey] = useState('')  // which INI key we're picking a file for
  const [fileBrowserPath, setFileBrowserPath] = useState('')
  const [fileBrowserDirs, setFileBrowserDirs] = useState<string[]>([])
  const [fileBrowserFiles, setFileBrowserFiles] = useState<{ name: string; ext: string }[]>([])
  const [fileBrowserParent, setFileBrowserParent] = useState<string | null>(null)
  const [fileBrowserLoading, setFileBrowserLoading] = useState(false)
  const [fileBrowserExtensions, setFileBrowserExtensions] = useState<string[]>([])
  const [fileBrowserSelected, setFileBrowserSelected] = useState<string | null>(null)

  const { toast } = useToast()
  const confirm = useConfirm()
  const { can } = useAuth()
  // Whole-router gate on the server: server/routes/serverFiles.js applies
  // requirePermission("serverfiles.manage") to every route in the file, GET
  // included -- there's no partial-access tier, so a page-level gate here is
  // the correct grain, not a compromise (Settings.tsx's precedent gates
  // whole TABS the same way, because that's the grain ITS capabilities come
  // in). can() fails OPEN when capabilities are unknown/null -- see
  // AuthContext's own doc comment -- so this only ever hides the page when
  // the answer is a confirmed no, never while unsure.
  const canManageServerFiles = can('serverfiles.manage')

  // Load initial data
  useEffect(() => {
    if (canManageServerFiles) loadData()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- intentional mount-only init

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current)
      }
    }
  }, [])

  const loadData = async () => {
    setLoading(true)
    const active = await serversApi.getResolvedActive().catch(() => ({ server: null }))
    const isRemote = !!active.server?.isRemote
    setActiveServerRemote(isRemote)
    setActiveServerName(active.server?.name || active.server?.serverName || null)
    try {
      // Load paths info first
      const paths = await serverFilesApi.getPaths()
      setPathsInfo(paths)

      // Load files that exist
      if (paths.exists.ini) {
        const iniData = await serverFilesApi.getIni()
        const merged = mergeSchemaDefaults(iniData.settings)
        setIniSettings(merged)
        setOriginalIniSettings(merged)
        setDuplicateKeys(iniData.duplicateKeys || [])
      }

      const sandboxRes = paths.exists.sandbox
        ? await serverFilesApi.getSandbox()
        : { sandbox: createSandboxDefaults() }
      setSandboxData(sandboxRes.sandbox)
      setOriginalSandboxData(sandboxRes.sandbox)

      if (paths.exists.spawnpoints) {
        const spawnRes = await serverFilesApi.getSpawnPoints()
        setSpawnPoints(spawnRes.spawnpoints)
      }

      if (paths.exists.spawnregions) {
        const regionsRes = await serverFilesApi.getSpawnRegions()
        setSpawnRegions(regionsRes.spawnregions)
      }
      setLoadError(null)
    } catch (error) {
      reportClientError('Failed to load config.', error)
      // getServerConfigPath() (server/routes/serverFiles.js) throws the same
      // "no active server" error for a genuinely-unconfigured panel AND for
      // a remote server with no SFTP transport set up -- the wire code can't
      // be trusted to tell those apart here. When we independently know the
      // active server IS set and IS remote, say that instead of repeating
      // the server's misleading "no active server" text: reuse the exact
      // copy errors.json already ships for this condition everywhere else
      // remote config access is gated (server/routes/serverFiles.js's own
      // second-stage SFTP-transport gate), rather than inventing new copy.
      const message = isRemote
        ? i18n.t('REMOTE_CONFIG_NOT_CONFIGURED', { ns: 'errors' })
        : getUserErrorMessage(error, t('toasts.loadConfigFailed'))
      setLoadError(message)
      // The remote case renders as a persistent warning banner below (no
      // Retry button -- this is a setup step, not a failure), deliberately
      // not the destructive framing a toast titled "Error" would give it.
      // Firing that toast anyway said the opposite of what the banner right
      // under it says, and duplicated the same sentence a second time on
      // screen for a standing fact that isn't going away on its own, unlike
      // a genuine one-off fetch failure below, which still gets the toast.
      if (!isRemote) {
        toast({
          title: t('toasts.error'),
          description: message,
          variant: 'destructive'
        })
      }
    } finally {
      setLoading(false)
    }
  }

  // GH#118-adjacent (2026-08-26, "the sibling that was never hardened"):
  // serverApi.getStatus() is the raw local process scan -- correct for a
  // native server, but blind to a docker-managed server's process, which
  // runs in a different container this scan can never see (same root cause
  // as GH#114). Trusting it unconditionally here meant a live docker
  // container could read serverRunning=false, which suppresses BOTH the
  // "stop the server before editing" banner and the sticky-bar Discard
  // guard below. resolveServerRunning() (client/src/lib/serverStatus.ts)
  // shares resolveClientProvider() and the same 3-signal composed-status
  // read Layout.tsx/Dashboard.tsx already use (54cf13a/2d5745e), rather
  // than re-deriving a fourth implementation of the same idea -- see that
  // function's own doc comment for the fail-closed contract it guarantees.
  const refreshServerState = useCallback(async () => {
    try {
      const { server } = await serversApi.getActive()
      const running = await resolveServerRunning(server, serverApi.getStatus, serversApi.getComposedStatus)
      setServerRunning(running)
    } catch {
      setServerRunning(null)
    }
  }, [])

  // Only a CONFIRMED-stopped server (serverRunning === false) is safe to
  // let through unwarned. true (confirmed running) and null (unknown --
  // lookup failed, no active server, or an indeterminate composed signal)
  // both must behave as "it might be running": unknown is the safe answer
  // here, never the permissive one.
  const serverMayBeRunning = serverRunning !== false

  useEffect(() => {
    void refreshServerState()
    const interval = setInterval(() => { void refreshServerState() }, 5000)
    return () => clearInterval(interval)
  }, [refreshServerState])

  // Track if raw content is loading
  const [_loadingRaw, setLoadingRaw] = useState(false)

  // Load raw content when switching to raw mode
  const loadRawContent = async (type: 'ini' | 'sandbox' | 'spawnpoints' | 'spawnregions') => {
    setLoadingRaw(true)
    try {
      const data = await serverFilesApi.getRaw(type)
      setRawContent(data.content)
      setOriginalRawContent(data.content)
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.loadRawFailed')),
        variant: 'destructive'
      })
      // Reset to structured mode on error
      setEditorMode('structured')
    } finally {
      setLoadingRaw(false)
    }
  }

  // Check for unsaved changes
  const hasIniChanges = useMemo(() => {
    if (editorMode === 'raw' && activeTab === 'ini') {
      return rawContent !== originalRawContent
    }
    return JSON.stringify(iniSettings) !== JSON.stringify(originalIniSettings)
  }, [editorMode, activeTab, rawContent, originalRawContent, iniSettings, originalIniSettings])

  const hasSandboxChanges = useMemo(() => {
    if (editorMode === 'raw' && activeTab === 'sandbox') {
      return rawContent !== originalRawContent
    }
    return JSON.stringify(sandboxData) !== JSON.stringify(originalSandboxData)
  }, [editorMode, activeTab, rawContent, originalRawContent, sandboxData, originalSandboxData])

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault() }
    if (hasIniChanges || hasSandboxChanges) {
      window.addEventListener('beforeunload', handler)
    }
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasIniChanges, hasSandboxChanges])

  // Create manual backup
  const handleCreateBackup = async (type: 'ini' | 'sandbox' | 'spawnpoints' | 'spawnregions') => {
    try {
      const data = await serverFilesApi.getRaw(type)
      const blob = new Blob([data.content], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${data.filename}_${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
      a.click()
      URL.revokeObjectURL(url)
      toast({ title: t('toasts.downloadedTitle'), description: t('toasts.backupSavedDesc', { filename: data.filename }) })
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.downloadBackupFailed')),
        variant: 'destructive'
      })
    }
  }

  // Copy raw content to clipboard
  const handleCopyRaw = async () => {
    try {
      await copyText(rawContent)
      setCopied(true)
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current)
      }
      copiedTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
      toast({ title: t('toasts.copiedTitle'), description: t('toasts.copiedDesc') })
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.copyFailed')),
        variant: 'destructive'
      })
    }
  }

  // Save handlers

  // Load mod sandbox options from PanelBridge
  const loadModSettings = useCallback(async () => {
    const loadId = ++modSettingsLoadIdRef.current
    setModSettingsLoading(true)
    setModSettingsError(null)
    try {
      const response = await panelBridgeApi.sendCommand('getAllSandboxOptions', {}) as {
        success?: boolean
        data?: {
          options: Record<string, Array<{
            name?: string; shortName?: string; tableName?: string; value?: unknown;
            type?: string; min?: number; max?: number; default?: unknown;
            enumValues?: string[]; selectedIndex?: number; translatedName?: string;
            tooltip?: string; tooltipText?: string; pageName?: string;
          }>>
          groups: Array<{ name: string; count: number }>
          totalCount: number
          enumerated: boolean
        }
        error?: string
      }
      if (modSettingsLoadIdRef.current !== loadId) return
      if (response?.success && response.data) {
        const options = Object.fromEntries(
          Object.entries(response.data.options).filter(([groupName]) => !VANILLA_SANDBOX_GROUPS.has(groupName))
        )
        const groups = response.data.groups.filter(group => !VANILLA_SANDBOX_GROUPS.has(group.name))
        setModSettings(options)
        setModSettingsGroups(groups)
        setModSettingsLastLoaded(new Date())
        setModSettingsError(null)
      } else {
        setModSettingsError(response?.error || t('modSettingsTab.loadFailedNotConnected'))
      }
    } catch (error) {
      if (modSettingsLoadIdRef.current !== loadId) return
      setModSettingsError(getUserErrorMessage(error, t('modSettingsTab.loadFailedCheckConnection')))
    } finally {
      if (modSettingsLoadIdRef.current === loadId) setModSettingsLoading(false)
    }
  }, [t])

  // Auto-load mod settings the first time the user opens the tab.
  // After an error, we don't auto-retry — the user can click "Retry".
  useEffect(() => {
    if (activeTab === 'modsettings' && !modSettings && !modSettingsLoading && !modSettingsError) {
      loadModSettings()
    }
  }, [activeTab, modSettings, modSettingsLoading, modSettingsError, loadModSettings])

  // Keyboard shortcut: '/' focuses the mod settings search when the tab is active.
  // Skip when the user is already typing in a field or has a modifier held.
  useEffect(() => {
    if (activeTab !== 'modsettings') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return
      if (modSettingsSearchRef.current) {
        e.preventDefault()
        modSettingsSearchRef.current.focus()
        modSettingsSearchRef.current.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTab])

  const handleOptionChange = useCallback(async (optName: string, newValue: unknown, groupName: string) => {
    // Prevent duplicate inflight requests for the same option
    setSavingOptions(prev => {
      if (prev.has(optName)) return prev
      const next = new Set(prev)
      next.add(optName)
      return next
    })
    try {
      const response = await panelBridgeApi.sendCommand('setSandboxOption', { name: optName, value: newValue }) as {
        success?: boolean
        data?: { name: string; value: unknown; type: string; verified?: unknown; persisted?: unknown; saveError?: unknown }
        error?: string
      }
      if (response?.success && response.data) {
        const confirmedVal = response.data.value ?? newValue
        setModSettings(prev => {
          if (!prev) return prev
          const updated = { ...prev }
          const groupOpts = updated[groupName]
          if (groupOpts) {
            updated[groupName] = groupOpts.map(o => {
              if (o.name !== optName) return o
              const patched = { ...o, value: confirmedVal }
              // Sync selectedIndex for enums so the dropdown reflects the new value
              if (o.type === 'enum' && typeof confirmedVal === 'number') {
                patched.selectedIndex = confirmedVal
              }
              return patched
            })
          }
          return updated
        })
        // setSandboxOption's Lua handler reports this under `verified` as of
        // the matched->verified rename (2026-08-23, same pass as the shared
        // verify-gating helper) -- a mod still running the pre-rename build
        // reports the identical check under `matched` instead, which reads
        // here as 'old-bridge' (no `verified` key) until the operator
        // updates. That's the correct signal either way: an un-migrated mod
        // genuinely IS an old bridge relative to this contract.
        const verifyState = getBridgeVerifiedState('setSandboxOption', response.data)
        toast(
          verifyState === 'unverifiable'
            ? { title: t('toasts.optionUpdatedTitle'), description: t('toasts.bridgeUnverifiedDesc', { action: optName }), variant: 'default' }
            : verifyState === 'old-bridge'
              ? { title: t('toasts.optionUpdatedTitle'), description: t('toasts.bridgeOldBridgeDesc', { action: optName }), variant: 'default' }
              : { title: t('toasts.optionUpdatedTitle'), description: t('toasts.optionUpdatedDesc', { option: optName }) },
        )

        // See isWorldSaveFailure()'s own comment for the persisted/saveError
        // contract. This is a DIFFERENT persistence layer from the
        // SandboxVars.lua file write checked just below -- the two calls
        // hit different processes and different failure modes (e.g. "world
        // already saving" has nothing to do with whether the panel can
        // write a text file), so either can fail independently of the
        // other and each is worth telling the operator about on its own.
        if (isWorldSaveFailure(response.data)) {
          toast({
            title: t('toasts.appliedNotSavedTitle'),
            description: t('toasts.worldSaveFailedDesc', {
              option: optName,
              reason: typeof response.data.saveError === 'string' ? response.data.saveError : t('toasts.unknownError'),
            }),
            variant: 'destructive',
          })
        }

        // The bridge only changes the live value. Without this the option
        // reverts to whatever SandboxVars.lua still says on the next restart.
        try {
          const saved = await serverFilesApi.saveSandboxOption(
            optName,
            confirmedVal as string | number | boolean,
          )
          if (!saved.persisted) {
            toast({
              title: t('toasts.appliedNotSavedTitle'),
              description: t('toasts.notPersistedDesc', { option: optName }),
              variant: 'destructive',
            })
          }
        } catch (error) {
          // PUT /sandbox-option used to be gated behind "stop the server
          // first" (LOCAL_CONFIG_MUTATIONS in serverFiles.js), and since the
          // live edit above only ever succeeds while the server IS running,
          // this persistence attempt was guaranteed to 409 on every single
          // edit -- with getUserErrorMessage resolving that SERVER_RUNNING
          // code to "Stop the server before editing configuration" before it
          // ever looked at our fallback, actively bad advice since stopping
          // the server only locked the operator out of this tab. Measured
          // 2026-08-23 that a clean shutdown never rewrites this file at all,
          // so that gate was removed for this one route (server/routes/
          // serverFiles.js's LOCAL_CONFIG_MUTATIONS comment has the evidence)
          // and this call should no longer 409 in normal operation. Kept as
          // a defensive fallback in case SERVER_RUNNING is ever reached here
          // some other way -- still shows the accurate message instead of
          // letting the generic code lookup bury it.
          const isServerRunningRefusal = error instanceof ApiError && error.code === 'SERVER_RUNNING'
          toast({
            title: t('toasts.appliedNotSavedTitle'),
            description: isServerRunningRefusal
              ? t('toasts.willResetFallback', { option: optName })
              : getUserErrorMessage(error, t('toasts.willResetFallback', { option: optName })),
            variant: 'destructive',
          })
        }
      } else {
        toast({ title: t('toasts.failedToUpdateTitle'), description: response?.error || t('toasts.unknownError'), variant: 'destructive' })
      }
    } catch (error) {
      toast({ title: t('toasts.error'), description: getUserErrorMessage(error, t('toasts.setOptionFailed')), variant: 'destructive' })
    } finally {
      setSavingOptions(prev => {
        const next = new Set(prev)
        next.delete(optName)
        return next
      })
    }
  }, [toast, t])

  // File browser: open the dialog for a specific INI key
  const openFileBrowser = useCallback(async (key: string, extensions?: string[]) => {
    setFileBrowserKey(key)
    setFileBrowserExtensions(extensions || ['.png', '.jpg', '.jpeg'])
    setFileBrowserSelected(null)
    setFileBrowserOpen(true)
    setFileBrowserLoading(true)
    try {
      // Start browsing from server config path (or current value's directory)
      const currentValue = iniSettings[key]
      let startPath: string | undefined
      if (currentValue) {
        // Try the directory of the current value
        const lastSlash = Math.max(currentValue.lastIndexOf('/'), currentValue.lastIndexOf('\\'))
        if (lastSlash > 0) startPath = currentValue.substring(0, lastSlash)
      }
      const data = await serverFilesApi.browseFiles(startPath, extensions)
      setFileBrowserPath(data.currentPath)
      setFileBrowserDirs(data.directories)
      setFileBrowserFiles(data.files)
      setFileBrowserParent(data.parent)
    } catch {
      toast({ title: t('toasts.error'), description: t('toasts.browseFilesFailed'), variant: 'destructive' })
    } finally {
      setFileBrowserLoading(false)
    }
  }, [iniSettings, toast, t])

  // File browser: navigate to a directory
  const browseTo = useCallback(async (dirPath: string) => {
    setFileBrowserLoading(true)
    setFileBrowserSelected(null)
    try {
      const data = await serverFilesApi.browseFiles(dirPath, fileBrowserExtensions)
      setFileBrowserPath(data.currentPath)
      setFileBrowserDirs(data.directories)
      setFileBrowserFiles(data.files)
      setFileBrowserParent(data.parent)
    } catch {
      toast({ title: t('toasts.error'), description: t('toasts.navigateFailed'), variant: 'destructive' })
    } finally {
      setFileBrowserLoading(false)
    }
  }, [fileBrowserExtensions, toast, t])

  // File browser: confirm selection
  const confirmFileBrowserSelection = useCallback(() => {
    if (fileBrowserSelected && fileBrowserKey) {
      setIniSettings(prev => ({ ...prev, [fileBrowserKey]: fileBrowserSelected }))
      setFileBrowserOpen(false)
    }
  }, [fileBrowserSelected, fileBrowserKey])

  const handleSaveIni = async () => {
    setSaving(true)
    try {
      if (invalidIniSettings.length > 0) {
        toast({
          title: t('toasts.invalidIniTitle'),
          description: t('toasts.fixSettings', { settings: invalidIniSettings.map(getIniSettingLabel).join(listSep) }),
          variant: 'destructive',
        })
        return
      }
      if (editorMode === 'raw') {
        await serverFilesApi.saveRaw('ini', rawContent)
        setOriginalRawContent(rawContent)
      } else {
        await serverFilesApi.saveIni(iniSettings)
        setOriginalIniSettings({ ...iniSettings })
      }

      // Try to reload via RCON, but don't fail if RCON is not connected
      try {
        await serverFilesApi.saveAndReload()
        toast({ title: t('toasts.savedAndReloadedTitle'), description: t('toasts.savedIniReloadedDesc') })
      } catch {
        // File was saved, but RCON reload failed - that's okay
        toast({ title: t('toasts.savedTitle'), description: t('toasts.savedRestartToApply') })
      }

      // Refresh from server to ensure frontend matches the saved file
      try {
        if (editorMode === 'raw') {
          loadData()
        } else {
          const iniData = await serverFilesApi.getIni()
          const merged = mergeSchemaDefaults(iniData.settings)
          setIniSettings(merged)
          setOriginalIniSettings(merged)
        }
      } catch { /* silent refresh — local state is still valid */ }
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.saveSettingsFailed')),
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSaveSandbox = async () => {
    setSaving(true)
    try {
      if (editorMode === 'structured' && invalidSandboxSettings.length > 0) {
        toast({
          title: t('toasts.invalidSandboxTitle'),
          description: t('toasts.fixSettings', { settings: invalidSandboxSettings.map(getSandboxSettingLabel).join(listSep) }),
          variant: 'destructive',
        })
        return
      }
      // Sandbox settings have no RCON live-reload path: PZ's own /reloadoptions
      // command only re-reads ServerOptions.ini, never SandboxVars.lua (see
      // PanelBridge.lua's own comment to that effect). Unlike the INI save
      // below, a sandbox change always needs a restart to reach the running
      // game -- whether the server is stopped right now or running -- so
      // this never attempts a live reload and never claims one succeeded.
      if (editorMode === 'raw') {
        await serverFilesApi.saveRaw('sandbox', rawContent)
        setOriginalRawContent(rawContent)
      } else if (sandboxData) {
        // Create a deep copy to sanitize numbers
        const cleanData = JSON.parse(JSON.stringify(sandboxData)) as SandboxData

        // Ensure numbers are finite, canonical numbers before writing Lua.
        SANDBOX_SCHEMA.forEach(setting => {
          if (setting.type === 'number') {
            const section = (setting.section || 'settings') as keyof SandboxData
            if (cleanData[section]) {
              const sectionData = cleanData[section] as SandboxRecord
              const raw = sectionData[setting.key]
              if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
                const parsed = parseNumericSettingValue(raw, setting)
                if (parsed === null) throw new Error(t('toasts.settingInvalid', { label: getSandboxSettingLabel(setting) }))
                sectionData[setting.key] = parsed
              }
            }
          }
        })

        await serverFilesApi.saveSandbox(cleanData)
        // Update local state to match sanitized data
        setSandboxData(cleanData)
        setOriginalSandboxData(cleanData)
      }

      toast({ title: t('toasts.savedTitle'), description: t('toasts.savedRestartToApply') })

      // Refresh from server to ensure frontend matches the saved file
      try {
        if (editorMode === 'raw') {
          loadData()
        } else {
          const sandboxRes = await serverFilesApi.getSandbox()
          setSandboxData(sandboxRes.sandbox)
          setOriginalSandboxData(sandboxRes.sandbox)
        }
      } catch { /* silent refresh — local state is still valid */ }
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.saveSettingsFailed')),
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSaveSpawnPoints = async () => {
    setSaving(true)
    try {
      const result = editorMode === 'raw'
        ? await serverFilesApi.saveRaw('spawnpoints', rawContent)
        : await serverFilesApi.saveSpawnPoints(spawnPoints)
      toast({
        title: t('toasts.savedTitle'),
        description: result?.restartRequired ? t('toasts.savedRestartToApply') : t('toasts.spawnPointsSavedDesc'),
      })
      if (editorMode === 'raw') {
        loadData()
      }
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.saveSpawnPointsFailed')),
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  const handleSaveSpawnRegions = async () => {
    setSaving(true)
    try {
      const result = editorMode === 'raw'
        ? await serverFilesApi.saveRaw('spawnregions', rawContent)
        : await serverFilesApi.saveSpawnRegions(spawnRegions)
      toast({
        title: t('toasts.savedTitle'),
        description: result?.restartRequired ? t('toasts.savedRestartToApply') : t('toasts.spawnRegionsSavedDesc'),
      })
      if (editorMode === 'raw') {
        loadData()
      }
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.saveSpawnRegionsFailed')),
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }


  // Per-setting modified / non-default predicates (centralized so filter + badges use the same logic)
  const isIniModified = useCallback((s: IniSetting) => {
    const curr = iniSettings[s.key]
    const orig = originalIniSettings[s.key]
    return curr !== orig && orig !== undefined
  }, [iniSettings, originalIniSettings])

  const isIniNonDefault = useCallback((s: IniSetting) => {
    if (s.defaultComparable === false) return false
    const curr = iniSettings[s.key]
    if (curr === undefined) return false
    return String(curr) !== String(s.default ?? '')
  }, [iniSettings])

  const isSandboxModified = useCallback((s: SandboxSetting) => {
    if (!sandboxData || !originalSandboxData) return false
    const section = (s.section || 'settings') as keyof SandboxData
    const curr = (sandboxData[section] as SandboxRecord)?.[s.key]
    const orig = (originalSandboxData[section] as SandboxRecord)?.[s.key]
    return JSON.stringify(curr) !== JSON.stringify(orig)
  }, [sandboxData, originalSandboxData])

  const isSandboxNonDefault = useCallback((s: SandboxSetting) => {
    if (!sandboxData) return false
    const section = (s.section || 'settings') as keyof SandboxData
    const curr = (sandboxData[section] as SandboxRecord)?.[s.key]
    if (curr === undefined || curr === null) return false
    return String(curr) !== String(s.default ?? '')
  }, [sandboxData])

  // Filter settings by search + filter mode
  const filteredIniSettings = useMemo(() => {
    const lower = deferredSearchQuery.toLocaleLowerCase(searchLocale)
    const filtered = INI_SCHEMA.filter(s => {
      if (deferredSearchQuery && !getIniSettingSearchText(s).toLocaleLowerCase(searchLocale).includes(lower)) return false
      if (filterMode === 'modified' && !isIniNonDefault(s)) return false
      if (filterMode === 'nondefault' && !isIniModified(s)) return false
      return true
    })
    return groupByCategory(filtered)
  }, [deferredSearchQuery, filterMode, isIniModified, isIniNonDefault, searchLocale])

  const filteredSandboxSettings = useMemo(() => {
    const lower = deferredSearchQuery.toLocaleLowerCase(searchLocale)
    const filtered = SANDBOX_SCHEMA.filter(s => {
      if (deferredSearchQuery && !getSandboxSettingSearchText(s).toLocaleLowerCase(searchLocale).includes(lower)) return false
      if (filterMode === 'modified' && !isSandboxNonDefault(s)) return false
      if (filterMode === 'nondefault' && !isSandboxModified(s)) return false
      return true
    })
    return groupByCategory(filtered)
  }, [deferredSearchQuery, filterMode, isSandboxModified, isSandboxNonDefault, searchLocale])

  // Modified-count per category for rail badges
  const iniModifiedByCategory = useMemo(() => {
    const out: Record<string, number> = {}
    for (const s of INI_SCHEMA) if (isIniModified(s)) out[s.category] = (out[s.category] || 0) + 1
    return out
  }, [isIniModified])

  const sandboxModifiedByCategory = useMemo(() => {
    const out: Record<string, number> = {}
    for (const s of SANDBOX_SCHEMA) if (isSandboxModified(s)) out[s.category] = (out[s.category] || 0) + 1
    return out
  }, [isSandboxModified])

  // Unknown INI keys — keys present in the loaded file but not in the schema.
  // Mirrors the sandbox `uncategorized` pattern so mod-injected / new-vanilla keys remain editable.
  const uncategorizedIniKeys = useMemo(() => {
    const schemaKeys = new Set(INI_SCHEMA.map(s => s.key))
    const lower = deferredSearchQuery.toLowerCase()
    const out: { key: string; value: string }[] = []
    for (const [key, value] of Object.entries(iniSettings)) {
      if (schemaKeys.has(key) || UNSUPPORTED_INI_KEYS.has(key)) continue
      if (deferredSearchQuery && !(
        key.toLowerCase().includes(lower) ||
        String(value).toLowerCase().includes(lower)
      )) continue
      out.push({ key, value })
    }
    return out.sort((a, b) => a.key.localeCompare(b.key))
  }, [iniSettings, deferredSearchQuery])

  // Find sandbox settings not covered by the schema (mod settings, etc.)
  const uncategorizedSandboxKeys = useMemo(() => {
    if (!sandboxData) return []
    const schemaKeys = new Set(SANDBOX_SCHEMA.map(s => `${s.section || 'settings'}.${s.key}`))
    const uncategorized: { section: string; key: string; value: string | number | boolean }[] = []

    for (const sectionName of Object.keys(sandboxData)) {
      if (sectionName === 'VERSION') continue
      const sectionData = sandboxData[sectionName as keyof SandboxData]
      if (typeof sectionData !== 'object' || sectionData === null) continue
      for (const [key, value] of Object.entries(sectionData as Record<string, string | number | boolean>)) {
        if (key === 'VERSION') continue // file-format marker, not an editable setting
        if (!schemaKeys.has(`${sectionName}.${key}`)) {
          const lower = deferredSearchQuery?.toLowerCase() || ''
          if (!deferredSearchQuery || key.toLowerCase().includes(lower) || String(value).toLowerCase().includes(lower)) {
            uncategorized.push({ section: sectionName, key, value })
          }
        }
      }
    }
    return uncategorized.sort((a, b) => {
      if (a.section !== b.section) return a.section.localeCompare(b.section)
      return a.key.localeCompare(b.key)
    })
  }, [sandboxData, deferredSearchQuery])

  const uncategorizedGroups = useMemo(() => {
    const groups: Record<string, typeof uncategorizedSandboxKeys> = {}
    for (const entry of uncategorizedSandboxKeys) {
      const list = groups[entry.section] || (groups[entry.section] = [])
      list.push(entry)
    }
    return groups
  }, [uncategorizedSandboxKeys])

  // Load backups
  const loadBackups = async () => {
    try {
      const data = await serverFilesApi.getBackups()
      setBackups(data.backups)
      setShowBackups(true)
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.loadBackupsFailed')),
        variant: 'destructive'
      })
    }
  }

  // Restore backup
  const handleRestoreBackup = async (filename: string) => {
    const ok = await confirm({
      title: t('restoreBackupConfirm.title'),
      description: t('restoreBackupConfirm.description', { filename }),
      confirmLabel: t('restoreBackupConfirm.confirmLabel'),
    })
    if (!ok) return

    try {
      await serverFilesApi.restoreBackup(filename)
      toast({ title: t('toasts.restoredTitle'), description: t('toasts.restoredDesc', { filename }) })
      setShowBackups(false)
      loadData()
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.restoreBackupFailed')),
        variant: 'destructive'
      })
    }
  }

  // Load templates
  const loadTemplates = async () => {
    setTemplateLoading(true)
    try {
      const data = await serverFilesApi.getTemplates()
      setTemplates(data.templates)
      setShowTemplates(true)
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.loadTemplatesFailed')),
        variant: 'destructive'
      })
    } finally {
      setTemplateLoading(false)
    }
  }

  // Save current config as template
  const handleSaveTemplate = async () => {
    if (!newTemplateName.trim()) {
      toast({ title: t('toasts.error'), description: t('toasts.templateNameRequired'), variant: 'destructive' })
      return
    }

    setTemplateLoading(true)
    try {
      const result = await serverFilesApi.saveAsTemplate({
        name: newTemplateName.trim(),
        description: newTemplateDesc.trim(),
        includeIni: saveTemplateIni,
        includeSandbox: saveTemplateSandbox
      })
      toast({ title: t('toasts.savedTitle'), description: result.message })
      setShowSaveTemplate(false)
      setNewTemplateName('')
      setNewTemplateDesc('')
      // Refresh template list if dialog is open
      if (showTemplates) {
        const data = await serverFilesApi.getTemplates()
        setTemplates(data.templates)
      }
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.saveTemplateFailed')),
        variant: 'destructive'
      })
    } finally {
      setTemplateLoading(false)
    }
  }

  // Apply template
  const handleApplyTemplate = async (template: ConfigTemplate) => {
    // Templates never store the RCON/join password (POST /templates strips
    // it at save time -- see stripSensitiveIniLines() in serverFiles.js), so
    // applying an INI section always removes it from the live config rather
    // than leaving it untouched. That's an accident-shaped surprise unless
    // it's said out loud before the click, not after.
    const ok = await confirm({
      title: t('applyTemplateConfirm.title', { name: template.name }),
      description: template.hasIni
        ? `${t('applyTemplateConfirm.description')}\n\n${t('applyTemplateConfirm.rconWarning')}`
        : t('applyTemplateConfirm.description'),
      confirmLabel: t('applyTemplateConfirm.confirmLabel'),
    })
    if (!ok) return

    setTemplateLoading(true)
    try {
      const result = await serverFilesApi.applyTemplate(template.id)
      toast({
        title: t('toasts.appliedTitle'),
        description: result.message
      })
      setShowTemplates(false)
      loadData() // Reload the config data
    } catch (error) {
      const partiallyApplied = getPartiallyAppliedFromApplyTemplateError(error)
      if (partiallyApplied) {
        toast({
          title: t('toasts.applyTemplatePartialTitle'),
          description: t('toasts.applyTemplatePartialDesc', {
            applied: partiallyApplied.join(', '),
            error: getUserErrorMessage(error, t('toasts.applyTemplateFailed')),
          }),
          variant: 'destructive'
        })
        // The part that landed is now the live config -- reload so the
        // editor reflects disk instead of showing what was there before
        // the apply, which would silently disagree with the real file.
        loadData()
      } else {
        toast({
          title: t('toasts.error'),
          description: getUserErrorMessage(error, t('toasts.applyTemplateFailed')),
          variant: 'destructive'
        })
      }
    } finally {
      setTemplateLoading(false)
    }
  }

  // Delete template
  const handleDeleteTemplate = async (id: string, name: string) => {
    const ok = await confirm({
      title: t('deleteTemplateConfirm.title'),
      description: t('deleteTemplateConfirm.description', { name }),
      confirmLabel: t('deleteTemplateConfirm.confirmLabel'),
    })
    if (!ok) return

    try {
      await serverFilesApi.deleteTemplate(id)
      toast({ title: t('toasts.deletedTitle'), description: t('toasts.templateDeletedDesc', { name }) })
      setTemplates(prev => prev.filter(tpl => tpl.id !== id))
    } catch (error) {
      toast({
        title: t('toasts.error'),
        description: getUserErrorMessage(error, t('toasts.deleteTemplateFailed')),
        variant: 'destructive'
      })
    }
  }

  // Optimized update handlers
  const updateIniValue = useCallback((key: string, value: string) => {
    setIniSettings(prev => ({ ...prev, [key]: value }))
  }, [])

  // Unresolved Mods= triage actions (mods-unresolved-2026-08-31) -- both
  // stage an edit into the SAME unsaved iniSettings state as manually typing
  // in the field below would; nothing reaches disk until the operator hits
  // Save, same as every other edit on this page. That's what makes these
  // safe to offer without the bulk-disable the mods.resolved check's own
  // comment (Debug.tsx) deliberately avoids.
  const applyUnresolvedModCorrection = useCallback((modId: string, suggestion: string) => {
    setIniSettings(prev => {
      const tokens = (prev.Mods || '').split(';').map(v => v.trim()).filter(Boolean)
      const next = tokens.map(v => (v === modId ? suggestion : v))
      return { ...prev, Mods: next.join(';') }
    })
    toast({
      title: t('unresolvedReview.correctedTitle'),
      description: t('unresolvedReview.correctedToast', { modId, suggestion }),
    })
  }, [toast, t])

  const removeUnresolvedModEntry = useCallback(async (modId: string) => {
    const ok = await confirm({
      title: t('unresolvedReview.removeConfirmTitle'),
      description: t('unresolvedReview.removeConfirm', { modId }),
      confirmLabel: t('unresolvedReview.removeConfirmButton'),
      destructive: true,
    })
    if (!ok) return
    setIniSettings(prev => {
      const tokens = (prev.Mods || '').split(';').map(v => v.trim()).filter(Boolean)
      return { ...prev, Mods: tokens.filter(v => v !== modId).join(';') }
    })
    toast({
      title: t('unresolvedReview.removedTitle'),
      description: t('unresolvedReview.removedToast', { modId }),
    })
  }, [confirm, toast, t])

  const updateSandboxValue = useCallback((setting: SandboxSetting, value: SandboxScalar) => {
    setSandboxData(prev => {
      if (!prev) return prev
      const section = (setting.section || 'settings') as keyof SandboxData
      const sectionData = { ...(prev[section] as Record<string, unknown> || {}) }
      sectionData[setting.key] = value
      return { ...prev, [section]: sectionData } as SandboxData
    })
  }, [])

  // Reset individual INI setting to original loaded value
  const resetIniValue = useCallback((key: string) => {
    if (originalIniSettings[key] !== undefined) {
      setIniSettings(prev => ({ ...prev, [key]: originalIniSettings[key] }))
    }
  }, [originalIniSettings])

  // Discard all unsaved INI changes (sticky save bar)
  const discardIniChanges = useCallback(() => {
    setIniSettings({ ...originalIniSettings })
  }, [originalIniSettings])

  // Discard all unsaved Sandbox changes (sticky save bar)
  const discardSandboxChanges = useCallback(() => {
    if (originalSandboxData) setSandboxData(JSON.parse(JSON.stringify(originalSandboxData)))
  }, [originalSandboxData])

  // Reset individual Sandbox setting to original loaded value
  const resetSandboxValue = useCallback((setting: SandboxSetting) => {
    if (!originalSandboxData || !sandboxData) return
    const section = (setting.section || 'settings') as keyof SandboxData
    const originalSection = originalSandboxData[section] as SandboxRecord | undefined
    if (originalSection && originalSection[setting.key] !== undefined) {
      setSandboxData(prev => {
        if (!prev) return prev
        return {
          ...prev,
          [section]: {
            ...(prev[section] as SandboxRecord),
            [setting.key]: originalSection[setting.key]
          }
        }
      })
    }
  }, [originalSandboxData, sandboxData])

  // Count changed INI settings
  const changedIniCount = useMemo(() => {
    let count = 0
    for (const key of Object.keys(iniSettings)) {
      if (originalIniSettings[key] !== undefined && iniSettings[key] !== originalIniSettings[key]) count++
    }
    return count
  }, [iniSettings, originalIniSettings])

  // Count changed Sandbox settings
  const changedSandboxCount = useMemo(() => {
    if (!sandboxData || !originalSandboxData) return 0
    let count = 0
    SANDBOX_SCHEMA.forEach(setting => {
      const section = (setting.section || 'settings') as keyof SandboxData
      const curr = (sandboxData[section] as SandboxRecord)?.[setting.key]
      const orig = (originalSandboxData[section] as SandboxRecord)?.[setting.key]
      if (JSON.stringify(curr) !== JSON.stringify(orig)) count++
    })
    return count
  }, [sandboxData, originalSandboxData])

  // Search results count
  const searchResultsCount = useMemo(() => {
    if (!deferredSearchQuery) return 0
    if (activeTab === 'ini') {
      return Object.values(filteredIniSettings).reduce((acc, settings) => acc + settings.length, 0)
    }
    if (activeTab === 'sandbox') {
      return Object.values(filteredSandboxSettings).reduce((acc, settings) => acc + settings.length, 0)
    }
    return 0
  }, [deferredSearchQuery, activeTab, filteredIniSettings, filteredSandboxSettings])

  // Ctrl+S keyboard shortcut — use refs to avoid stale closure
  const handleSaveIniRef = useRef(handleSaveIni)
  const handleSaveSandboxRef = useRef(handleSaveSandbox)
  // Sync refs on every render so keyboard shortcut always calls latest version
  handleSaveIniRef.current = handleSaveIni
  handleSaveSandboxRef.current = handleSaveSandbox
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        if (activeTab === 'ini' && hasIniChanges) {
          handleSaveIniRef.current()
        } else if (activeTab === 'sandbox' && hasSandboxChanges) {
          handleSaveSandboxRef.current()
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        const searchInput = activeTab === 'ini' ? iniSearchRef.current : sandboxSearchRef.current
        searchInput?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTab, hasIniChanges, hasSandboxChanges])

  if (!canManageServerFiles) {
    return (
      <div className="space-y-4 page-transition">
        <EmptyState
          type="noData"
          title={t('noAccess.title')}
          description={t('noAccess.description')}
        />
      </div>
    )
  }

  if (loading) {
    return (
      <div className="space-y-4 page-transition">
        <div className="rounded-lg border border-border/40 bg-card/40 px-4 py-3 sm:px-5 sm:py-4">
          <div className="h-3 w-20 rounded bg-muted/50 animate-pulse mb-2" />
          <div className="h-6 w-64 rounded bg-muted/60 animate-pulse mb-2" />
          <div className="h-3 w-96 rounded bg-muted/40 animate-pulse" />
        </div>
        <div className="rounded-md border border-border/55 bg-card/85 h-12 animate-pulse" />
        <div className="flex gap-1">
          {[0,1,2,3,4].map(i => (
            <div key={i} className="flex-1 h-9 rounded-md bg-muted/40 animate-pulse" />
          ))}
        </div>
        <div className="rounded-md border border-border/55 bg-card/85 h-[400px] flex items-center justify-center">
          <div className="flex items-center gap-3 text-muted-foreground text-xs font-medium">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('loading')}
          </div>
        </div>
      </div>
    )
  }

  // Stats calculations
  const iniSettingsCount = Object.keys(iniSettings).length
  const sandboxSettingsCount = sandboxData ? Object.keys(sandboxData.settings || {}).length : 0
  const spawnPointsCount = Object.values(spawnPoints).reduce((acc, points) => acc + points.length, 0)
  const professionsCount = Object.keys(spawnPoints).length

  return (
    <div className="space-y-4 page-transition pb-24">
      {loadError && (
        activeServerRemote ? (
          // Remote-with-no-SFTP-transport isn't a failure to retry -- it's a
          // configuration step the operator hasn't done yet (same class as
          // Backups.tsx's/ChunkCleaner's own remote-server alerts), so this
          // uses their warning styling instead of a destructive one, and
          // drops the Retry button: retrying can't turn a remote server into
          // a local one, or add SFTP details on its own.
          <Alert className="border-warning/40 bg-warning/10">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertTitle>{t('loadErrorTitle')}</AlertTitle>
            <AlertDescription className="min-w-0 break-words" dir="auto" title={loadError}>
              {loadError}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{t('loadErrorTitle')}</AlertTitle>
            <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0 break-words" dir="auto" title={loadError}>{loadError}</span>
              <Button variant="outline" size="sm" onClick={loadData} className="self-start">
                <RefreshCw className="me-2 h-4 w-4" /> {t('retry')}
              </Button>
            </AlertDescription>
          </Alert>
        )
      )}

      {/* Duplicate-key warning: a setting appears more than once as its own
          line in the raw INI. This editor's parseIni() (a line-by-line
          `result[key] = value` loop) lets the LAST occurrence win, while the
          Mods page's own reads/writes only ever see the FIRST -- two screens
          the operator can both have open at once, showing different values
          for the same nominal setting. Same idiom as Mods.tsx's own
          duplicateKeysWarning (d725dbe) on purpose: one condition, one
          visual language, not two. See server/utils/iniDuplicateKeys.js. */}
      {duplicateKeys.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3 sm:items-center">
            <AlertTriangle className="w-5 h-5 text-warning" />
            <div>
              <p className="font-medium text-warning">
                {t('duplicateKeysWarning.title', {
                  count: duplicateKeys.length,
                  keys: duplicateKeys.map(d => d.key).join(', '),
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('duplicateKeysWarning.desc')}
              </p>
            </div>
          </div>
        </div>
      )}

      <PageHeader
        title={t('pageHeader.title')}
        description={t('pageHeader.description')}
        eyebrow={t('pageHeader.eyebrow')}
        tone="config"
        icon={<Settings className="h-5 w-5 text-primary" />}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            {(hasIniChanges || hasSandboxChanges) && (
              <Badge variant="warning" className="motion-safe:animate-pulse text-xs font-medium">
                <AlertTriangle className="me-1 h-3 w-3" />
                {t('pageHeader.unsavedChanges')}
              </Badge>
            )}
            <Button variant="command" size="sm" className="h-9 gap-1.5 text-xs font-medium" onClick={loadTemplates}>
              <Bookmark className="h-3.5 w-3.5" /> {t('pageHeader.templates')}
            </Button>
            <Button variant="command" size="sm" className="h-9 gap-1.5 text-xs font-medium" onClick={loadBackups}>
              <History className="h-3.5 w-3.5" /> {t('pageHeader.backups')}
            </Button>
            <Button variant="command" size="sm" className="h-9 gap-1.5 text-xs font-medium" onClick={loadData}>
              <RefreshCw className="h-3.5 w-3.5" /> {t('pageHeader.refresh')}
            </Button>
          </div>
        }
      />

      {/* ACTIVE SERVER STRIP */}
      <TacticalPanel tone="primary">
        <div className="px-3 py-2.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
              <FolderOpen className="w-3.5 h-3.5" />
              <span>{t('activeServerStrip.label')}</span>
            </div>
            {pathsInfo ? (
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-foreground">
                  {pathsInfo.serverName}
                </span>
                <span className="text-muted-foreground/40">·</span>
                <span
                  className="min-w-0 truncate font-mono text-xs text-muted-foreground"
                  title={pathsInfo.configPath}
                  dir="ltr"
                >
                  {pathsInfo.configPath}
                </span>
              </div>
            ) : activeServerName ? (
              // pathsInfo is null here because the load failed -- but a
              // remote-without-SFTP-transport failure (see loadData) still
              // means a real server is active, just not this one, so say so
              // instead of "No server selected", which the sidebar right
              // next to this strip already contradicts.
              <span className="text-sm font-semibold text-foreground">{activeServerName}</span>
            ) : (
              <span className="text-xs text-muted-foreground/60">{t('activeServerStrip.noServerSelected')}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground">
            <StatChip
              icon={<Settings className="h-3 w-3" />}
              value={iniSettingsCount}
              label={t('activeServerStrip.iniLabel')}
              ok={pathsInfo?.exists.ini}
            />
            <span className="h-3 w-px bg-border/60" aria-hidden />
            <StatChip
              icon={<FileText className="h-3 w-3" />}
              value={sandboxSettingsCount}
              label={t('activeServerStrip.sandboxLabel')}
              ok={pathsInfo?.exists.sandbox}
            />
            <span className="h-3 w-px bg-border/60" aria-hidden />
            <StatChip
              icon={<MapPin className="h-3 w-3" />}
              value={spawnPointsCount}
              label={t('activeServerStrip.spawnsLabel', { count: professionsCount })}
            />
            <span className="h-3 w-px bg-border/60" aria-hidden />
            <StatChip
              icon={<Map className="h-3 w-3" />}
              value={spawnRegions.length}
              label={t('activeServerStrip.regionsLabel')}
            />
          </div>
        </div>
      </TacticalPanel>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => {
        setActiveTab(v)
        if (editorMode === 'raw') {
          const typeMap: Record<string, 'ini' | 'sandbox' | 'spawnpoints' | 'spawnregions'> = {
            ini: 'ini',
            sandbox: 'sandbox',
            spawnpoints: 'spawnpoints',
            spawnregions: 'spawnregions'
          }
          loadRawContent(typeMap[v] || 'ini')
        }
      }}>
        <TabsList className="flex h-auto flex-wrap gap-1 bg-muted/30 border border-border/50 p-1 rounded-md w-full">
          {([
            // pathsInfo is null both for a genuinely-unconfigured panel (where
            // "missing" is correct -- there is no file) and for a remote
            // server with no SFTP transport set up (loadData, ~line 1050),
            // where nothing is actually confirmed missing, only unreachable.
            // The banner above already explains the real reason for the
            // remote case with its own copy -- don't also claim these two
            // specific files are missing, which the sidebar's REMOTE badge
            // two rows up already contradicts.
            { value: 'ini', label: t('tabs.serverSettings'), icon: Settings, dirty: hasIniChanges, count: changedIniCount, missing: !activeServerRemote && !pathsInfo?.exists.ini },
            { value: 'sandbox', label: t('tabs.sandbox'), icon: FileText, dirty: hasSandboxChanges, count: changedSandboxCount, missing: !activeServerRemote && !pathsInfo?.exists.sandbox },
            { value: 'spawnpoints', label: t('tabs.spawnPoints'), icon: MapPin, dirty: false, count: 0, missing: false },
            { value: 'spawnregions', label: t('tabs.spawnRegions'), icon: Map, dirty: false, count: 0, missing: false },
            { value: 'modsettings', label: t('tabs.modSettings'), icon: Puzzle, dirty: false, count: modifiedModSettingsCount, missing: false },
          ] as const).map((tabDef) => (
            <TabsTrigger
              key={tabDef.value}
              value={tabDef.value}
              className="flex-1 min-w-[120px] flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none"
            >
              <tabDef.icon className="w-4 h-4 shrink-0" />
              {tabDef.label}
              {tabDef.count > 0 && (
                <Badge variant="warning" className="h-5 px-1.5 py-0 font-mono text-[10px] leading-none">
                  {tabDef.count}
                </Badge>
              )}
              {tabDef.dirty && activeTab !== tabDef.value && (
                <span className="h-1.5 w-1.5 rounded-full bg-warning motion-safe:animate-pulse" aria-label={t('tabs.unsavedChangesAria')} />
              )}
              {tabDef.missing && (
                <AlertCircle className="w-4 h-4 text-warning" aria-label={t('tabs.fileMissingAria')} />
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {activeTab === 'ini' && initialDeepLink.unresolved.length > 0 && (
          <Alert className="mt-3 border-warning/40 bg-warning/10">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertTitle className="text-warning">{t('unresolvedReview.title')}</AlertTitle>
            <AlertDescription className="mt-2 space-y-3">
              {initialDeepLink.unresolved.map((modId) => {
                const triage = initialDeepLink.unresolvedTriage.get(modId)
                // Chip + action button share one line (both short, never wrap
                // badly); the explanation is its own line below so a long
                // sentence (workshopNotOnDisk especially) can wrap freely
                // without dragging the button out of line with the chip.
                return (
                  <div key={modId}>
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="rounded border border-warning/30 bg-background/50 px-1.5 py-0.5 text-xs text-foreground">
                        {modId}
                      </code>
                      {triage?.cause === 'typo' && triage.suggestion && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          onClick={() => applyUnresolvedModCorrection(modId, triage.suggestion as string)}
                        >
                          {t('unresolvedReview.correctAction', { suggestion: triage.suggestion })}
                        </Button>
                      )}
                      {(triage?.cause === 'stillDownloading' || triage?.cause === 'workshopNotOnDisk') && (
                        <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-xs">
                          <Link to="/debug">{t('unresolvedReview.rerunDiagnostics')}</Link>
                        </Button>
                      )}
                      {triage?.cause === 'absent' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs text-destructive border-destructive/40 hover:bg-destructive/10"
                          onClick={() => removeUnresolvedModEntry(modId)}
                        >
                          {t('unresolvedReview.removeAction')}
                        </Button>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {!triage && t('unresolvedReview.causeUnknown')}
                      {triage?.cause === 'typo' && triage.suggestion && t('unresolvedReview.causeTypo', { suggestion: triage.suggestion })}
                      {triage?.cause === 'stillDownloading' && t('unresolvedReview.causeStillDownloading')}
                      {triage?.cause === 'workshopNotOnDisk' && t('unresolvedReview.causeWorkshopNotOnDisk')}
                      {triage?.cause === 'absent' && t('unresolvedReview.causeAbsent')}
                    </p>
                  </div>
                )
              })}
            </AlertDescription>
          </Alert>
        )}
        {serverMayBeRunning && ['ini', 'sandbox', 'spawnpoints', 'spawnregions'].includes(activeTab) && (
          <Alert className="mt-3 border-primary/30 bg-primary/5">
            <Info className="h-4 w-4 text-primary" />
            <AlertTitle>{serverRunning === true ? t('stopServerAlert.title') : t('stopServerAlert.unknownTitle')}</AlertTitle>
            <AlertDescription>
              {serverRunning === true ? t('stopServerAlert.description') : t('stopServerAlert.unknownDescription')}
            </AlertDescription>
          </Alert>
        )}
        {activeTab === 'ini' && invalidIniSettings.length > 0 && (
          <Alert className="mt-3 border-destructive/40 bg-destructive/10">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <AlertTitle>{t('invalidValuesAlert.title')}</AlertTitle>
            <AlertDescription>
              {t('invalidValuesAlert.description', { settings: invalidIniSettings.map(getIniSettingLabel).join(listSep) })}
            </AlertDescription>
          </Alert>
        )}
        {activeTab === 'sandbox' && invalidSandboxSettings.length > 0 && (
          <Alert className="mt-3 border-destructive/40 bg-destructive/10">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <AlertTitle>{t('invalidValuesAlert.title')}</AlertTitle>
            <AlertDescription>
              {t('invalidValuesAlert.description', { settings: invalidSandboxSettings.map(getSandboxSettingLabel).join(listSep) })}
            </AlertDescription>
          </Alert>
        )}

        {/* INI Settings Tab */}
        <TabsContent value="ini" className="mt-4">
          <TacticalPanel tone={hasIniChanges ? 'warning' : 'primary'}>
            <SectionHeader
              label={t('iniTab.sectionLabel')}
              sublabel={t('iniTab.sectionSublabel')}
              icon={FileText}
              tone={hasIniChanges ? 'warning' : 'primary'}
              action={
                <div className="flex flex-wrap items-center gap-1.5">
                  {hasIniChanges && (
                    <Badge variant="warning" className="h-5 px-1.5 py-0 font-mono text-[10px]">
                      <AlertTriangle className="me-1 h-3 w-3" />
                      {changedIniCount}
                    </Badge>
                  )}
                  <div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 p-0.5">
                    <Button
                      variant={editorMode === 'structured' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => setEditorMode('structured')}
                      className="h-7 gap-1.5 px-2 text-xs font-medium"
                      aria-pressed={editorMode === 'structured'}
                    >
                      <FormInput className="h-3 w-3" /> {t('editorToolbar.form')}
                    </Button>
                    <Button
                      variant={editorMode === 'raw' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        setEditorMode('raw')
                        loadRawContent('ini')
                      }}
                      className="h-7 gap-1.5 px-2 text-xs font-medium"
                      aria-pressed={editorMode === 'raw'}
                    >
                      <Code className="h-3 w-3" /> {t('editorToolbar.raw')}
                    </Button>
                  </div>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => handleCreateBackup('ini')} aria-label={t('editorToolbar.downloadIniAria')}>
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('editorToolbar.downloadIniTooltip')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <a
                    href="https://pzwiki.net/wiki/Server_settings"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-7 items-center gap-1 rounded border border-border/60 bg-muted/30 px-2 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-primary"
                  >
                    <ExternalLink className="h-3 w-3" /> {t('editorToolbar.wiki')}
                  </a>
                  <Button onClick={handleSaveIni} disabled={saving || !hasIniChanges || invalidIniSettings.length > 0} variant="command" size="sm" className="h-7 gap-1.5 text-xs font-medium">
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    {t('editorToolbar.saveAndReload')}
                  </Button>
                </div>
              }
            />
            <div className="p-4">
              {iniSettings['DoLuaChecksum']?.toLowerCase() === 'true' && (
                <Alert variant="destructive" className="mb-4">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>{t('iniTab.luaChecksumTitle')}</AlertTitle>
                  <AlertDescription>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <span className="min-w-0 flex-1">
                        <Trans i18nKey="iniTab.luaChecksumBody" t={t} components={{ 1: <strong /> }} />
                      </span>
                      <Button
                        size="sm"
                        variant="command"
                        className="h-7 shrink-0 gap-1.5 text-xs font-medium"
                        onClick={() => updateIniValue('DoLuaChecksum', 'false')}
                      >
                        {t('iniTab.disableNow')}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              {editorMode === 'raw' ? (
                <div className="relative">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="absolute top-2 right-2 z-10"
                          onClick={handleCopyRaw}
                        >
                          {copied ? (
                            <Check className="w-4 h-4 text-primary" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{copied ? t('editorToolbar.copied') : t('editorToolbar.copyToClipboard')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <Textarea
                    value={rawContent}
                    onChange={(e) => setRawContent(e.target.value)}
                    className="h-[calc(100vh-380px)] min-h-[400px] resize-y font-mono text-sm"
                    spellCheck={false}
                  />
                </div>
              ) : (
                <div className="min-h-[400px]">
                  {/* Scoped search + filter mode — applies to all categories on this tab */}
                  <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="relative min-w-0 flex-1 sm:max-w-md">
                      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        ref={iniSearchRef}
                        placeholder={t('search.settingsPlaceholder')}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="h-8 bg-background/50 ps-9 pe-20"
                        aria-label={t('search.aria')}
                        maxLength={128}
                      />
                      {searchQuery && (
                        <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
                          <span className="text-[11px] tabular-nums text-muted-foreground">
                            {searchResultsCount}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="pointer-events-auto h-6 w-6 p-0"
                            onClick={() => setSearchQuery('')}
                            aria-label={t('search.clearAria')}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="ms-auto flex items-center gap-2">
                      <div className="inline-flex items-center rounded-md border border-border/60 bg-background/50 p-0.5" role="group" aria-label={t('search.filterAria')}>
                        {(['all','modified','nondefault'] as const).map(mode => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setFilterMode(mode)}
                            className={`h-7 px-2.5 text-xs font-medium rounded transition-colors ${
                              filterMode === mode
                                ? 'bg-primary/15 text-primary'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {mode === 'nondefault' ? t('search.filterUnsaved') : mode === 'modified' ? t('search.filterModified') : t('search.filterAll')}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {searchQuery ? (
                    // Search mode: flat results across all categories, grouped by category label
                    <ScrollArea className="h-[calc(100vh-420px)] min-h-[360px] pe-4">
                      {INI_CATEGORIES.map(category => {
                        const settings = filteredIniSettings[category.id] || []
                        if (settings.length === 0) return null
                        return (
                          <div key={category.id} className="mb-5">
                            <div className="sticky top-0 z-10 -mx-1 mb-2 flex items-baseline gap-2 bg-card/95 px-1 py-1.5 backdrop-blur">
                              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                {getIniCategoryLabel(category)}
                              </span>
                              <span className="text-[10px] text-muted-foreground/70">
                                {t('categoriesNav.matchCount', { count: settings.length })}
                              </span>
                            </div>
                            <div className="space-y-1">
                              {settings.map(setting => (
                                <IniSettingRow
                                  key={setting.key}
                                  setting={setting}
                                  value={iniSettings[setting.key] || ''}
                                  originalValue={originalIniSettings[setting.key]}
                                  onChange={updateIniValue}
                                  onReset={resetIniValue}
                                  onBrowse={openFileBrowser}
                                />
                              ))}
                            </div>
                          </div>
                        )
                      })}
                      {searchResultsCount === 0 && (
                        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                          {t('search.noMatches', { query: searchQuery })}
                        </div>
                      )}
                    </ScrollArea>
                  ) : (
                    // Rail mode: vertical category nav (grouped) + single active category content
                    <div className="grid gap-0 md:grid-cols-[252px_minmax(0,1fr)]">
                      <nav
                        aria-label={t('categoriesNav.iniAria')}
                        className="-mx-2 flex flex-col gap-0.5 px-2 pb-2 md:mx-0 md:order-1 md:border-e md:border-border/50 md:pb-0 md:pe-3 md:pt-1 md:max-h-[calc(100vh-420px)] md:min-h-[360px] md:overflow-y-auto"
                      >
                        <div className="hidden md:flex items-center justify-between px-3 pb-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                            {t('categoriesNav.categoriesLabel')}
                          </span>
                          <button
                            type="button"
                            onClick={() => setAllGroupsCollapsed('ini', !iniAllCollapsed)}
                            className="inline-flex items-center gap-1 rounded text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 hover:text-foreground transition-colors"
                            aria-label={iniAllCollapsed ? t('categoriesNav.expandAllAria') : t('categoriesNav.collapseAllAria')}
                          >
                            {iniAllCollapsed
                              ? <ChevronsUpDown className="h-3 w-3" />
                              : <ChevronsDownUp className="h-3 w-3" />}
                            <span>{iniAllCollapsed ? t('categoriesNav.expandAll') : t('categoriesNav.collapseAll')}</span>
                          </button>
                        </div>
                        {INI_CATEGORY_GROUPS.map((group, gIdx) => {
                          const groupLabel = getIniCategoryGroupLabel(group)
                          const cats = INI_CATEGORIES.filter(c => c.group === group.id)
                          // Hide whole group if every category is empty under current filter
                          const totalInGroup = cats.reduce((acc, c) => acc + (filteredIniSettings[c.id] || []).length, 0)
                          if (totalInGroup === 0 && filterMode !== 'all') return null
                          const groupKey = `ini:${group.id}`
                          const isCollapsed = !!collapsedGroups[groupKey]
                          const groupModCount = cats.reduce((acc, c) => acc + (iniModifiedByCategory[c.id] || 0), 0)
                          return (
                            <div key={group.id} className={`shrink-0 md:shrink ${gIdx > 0 ? 'mt-2 md:mt-3' : ''}`}>
                              <button
                                type="button"
                                onClick={() => toggleGroup(groupKey)}
                                aria-expanded={!isCollapsed}
                                className="hidden md:flex w-full items-center gap-2 px-3 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-foreground/80 hover:text-foreground transition-colors"
                              >
                                {isCollapsed
                                  ? <ChevronRight className="h-3 w-3 shrink-0" />
                                  : <ChevronDown className="h-3 w-3 shrink-0" />
                                }
                                <span>{groupLabel}</span>
                                {groupModCount > 0 && (
                                  <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-[8px] font-semibold text-warning">{groupModCount}</span>
                                )}
                                <span className="h-px flex-1 bg-border/40" />
                              </button>
                              {!isCollapsed && cats.map(category => {
                                const count = (filteredIniSettings[category.id] || []).length
                                if (count === 0 && filterMode !== 'all') return null
                                const isActive = activeIniCategory === category.id
                                const modCount = iniModifiedByCategory[category.id] || 0
                                return (
                                  <button
                                    key={category.id}
                                    type="button"
                                    onClick={() => setActiveIniCategory(category.id)}
                                    aria-current={isActive ? 'page' : undefined}
                                    className={`group relative flex shrink-0 items-center gap-2 whitespace-nowrap border-s-2 px-3 py-2 text-start text-sm transition-colors md:whitespace-normal ${
                                      isActive
                                        ? 'border-primary bg-primary/10 text-primary'
                                        : 'border-transparent text-muted-foreground hover:border-primary/30 hover:bg-muted/40 hover:text-foreground'
                                    }`}
                                  >
                                    <CategoryIcon name={category.icon} isActive={isActive} className="h-4 w-4 shrink-0" />
                                    <span className="min-w-0 flex-1 truncate font-medium" title={getIniCategoryLabel(category)}>{getIniCategoryLabel(category)}</span>
                                    {modCount > 0 && (
                                      <span
                                        className="shrink-0 rounded-full bg-warning/20 px-1.5 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wider text-warning"
                                        title={t('categoriesNav.modifiedCountTitle', { count: modCount })}
                                      >
                                        {modCount}
                                      </span>
                                    )}
                                    <span className={`shrink-0 min-w-[1.5rem] rounded text-center px-1 py-0.5 text-[10px] font-mono tabular-nums ${
                                      isActive ? 'text-primary/80' : 'bg-muted text-muted-foreground'
                                    }`}>
                                      {count}
                                    </span>
                                  </button>
                                )
                              })}
                            </div>
                          )
                        })}
                        {uncategorizedIniKeys.length > 0 && (() => {
                          const isActive = activeIniCategory === 'uncategorized'
                          return (
                            <button
                              key="uncategorized"
                              type="button"
                              onClick={() => setActiveIniCategory('uncategorized')}
                              aria-current={isActive ? 'page' : undefined}
                              className={`group relative mt-2 flex shrink-0 items-center gap-2 whitespace-nowrap border-s-2 px-3 py-2 text-start text-sm transition-colors md:mt-3 md:whitespace-normal md:border-t md:border-t-border/50 md:pt-3 ${
                                isActive
                                  ? 'border-s-amber-500 bg-amber-500/10 text-amber-500'
                                  : 'border-s-transparent text-muted-foreground hover:border-s-amber-500/30 hover:bg-amber-500/5 hover:text-amber-500/80'
                              }`}
                              title={t('categoriesNav.uncategorizedIniTitle')}
                            >
                              <span className="min-w-0 flex-1 truncate font-medium">{t('categoriesNav.uncategorizedIniLabel')}</span>
                              <span className={`shrink-0 min-w-[1.5rem] rounded text-center px-1 py-0.5 text-[10px] font-mono tabular-nums ${
                                isActive ? 'text-amber-500/80' : 'bg-muted text-muted-foreground'
                              }`}>
                                {uncategorizedIniKeys.length}
                              </span>
                            </button>
                          )
                        })()}
                      </nav>
                      <ScrollArea className="h-[calc(100vh-420px)] min-h-[360px] md:ps-5 pe-4 md:order-2">
                        {(() => {
                          if (activeIniCategory === 'uncategorized') {
                            if (uncategorizedIniKeys.length === 0) {
                              return (
                                <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                                  {t('uncategorizedIni.empty')}
                                </div>
                              )
                            }
                            return (
                              <div>
                                <div className="sticky top-0 z-10 -mx-1 mb-3 flex items-baseline justify-between border-b border-amber-500/30 bg-card/95 px-1 pb-2 pt-1 backdrop-blur">
                                  <h3 className="text-sm font-semibold uppercase tracking-wider text-amber-500">
                                    {t('uncategorizedIni.heading')}
                                  </h3>
                                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                                    {t('uncategorizedIni.keyCount', { count: uncategorizedIniKeys.length })}
                                  </span>
                                </div>
                                <p className="mb-3 text-xs text-muted-foreground">
                                  {t('uncategorizedIni.description')}
                                </p>
                                <div className="space-y-1">
                                  {uncategorizedIniKeys.map(({ key, value }) => {
                                    const orig = originalIniSettings[key]
                                    const isModified = orig !== undefined && orig !== value
                                    return (
                                      <div key={key} className={`flex items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors ${isModified ? 'border border-amber-500/20 bg-amber-500/10' : 'hover:bg-muted/50'}`}>
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-center gap-2">
                                            <span className="truncate text-sm font-medium" title={key}>{key}</span>
                                            {isModified && (
                                              <button
                                                onClick={() => setIniSettings(prev => ({ ...prev, [key]: orig ?? '' }))}
                                                className="text-xs text-amber-500 hover:text-amber-400"
                                                title={t('uncategorizedIni.undoTitle')}
                                                aria-label={t('uncategorizedIni.undoTitle')}
                                              >↩</button>
                                            )}
                                          </div>
                                        </div>
                                        <Input
                                          className="h-8 w-56 text-sm"
                                          value={value}
                                          maxLength={500}
                                          onChange={e => setIniSettings(prev => ({ ...prev, [key]: e.target.value }))}
                                        />
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            )
                          }
                          const settings = filteredIniSettings[activeIniCategory] || []
                          const active = INI_CATEGORIES.find(c => c.id === activeIniCategory)
                          if (settings.length === 0) {
                            return (
                              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                                {filterMode === 'modified' ? t('categoryContent.noneModified') :
                                 filterMode === 'nondefault' ? t('categoryContent.noneUnsaved') :
                                 t('categoryContent.none')}
                              </div>
                            )
                          }
                          return (
                            <div>
                              <div className="sticky top-0 z-10 -mx-1 mb-3 flex items-baseline justify-between border-b border-border/50 bg-card/95 px-1 pb-2 pt-1 backdrop-blur">
                                <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">
                                  {active ? getIniCategoryLabel(active) : null}
                                </h3>
                                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                                  {t('categoryContent.settingCount', { count: settings.length })}
                                </span>
                              </div>
                              <div className="space-y-1">
                                {settings.map(setting => (
                                  <IniSettingRow
                                    key={setting.key}
                                    setting={setting}
                                    value={iniSettings[setting.key] || ''}
                                    originalValue={originalIniSettings[setting.key]}
                                    onChange={updateIniValue}
                                    onReset={resetIniValue}
                                    onBrowse={openFileBrowser}
                                  />
                                ))}
                              </div>
                            </div>
                          )
                        })()}
                      </ScrollArea>
                    </div>
                  )}
                </div>
              )}
            </div>
          </TacticalPanel>
        </TabsContent>

        {/* Sandbox Tab */}
        <TabsContent value="sandbox" className="mt-4">
          <TacticalPanel tone={hasSandboxChanges ? 'warning' : 'primary'}>
            <SectionHeader
              label={t('sandboxTab.sectionLabel')}
              sublabel={t('sandboxTab.sectionSublabel')}
              icon={Code}
              tone={hasSandboxChanges ? 'warning' : 'primary'}
              action={
                <div className="flex flex-wrap items-center gap-1.5">
                  {hasSandboxChanges && (
                    <Badge variant="warning" className="h-5 px-1.5 py-0 font-mono text-[10px]">
                      <AlertTriangle className="me-1 h-3 w-3" />
                      {changedSandboxCount}
                    </Badge>
                  )}
                  <div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 p-0.5">
                    <Button
                      variant={editorMode === 'structured' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => setEditorMode('structured')}
                      className="h-7 gap-1.5 px-2 text-xs font-medium"
                      aria-pressed={editorMode === 'structured'}
                    >
                      <FormInput className="h-3 w-3" /> {t('editorToolbar.form')}
                    </Button>
                    <Button
                      variant={editorMode === 'raw' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        setEditorMode('raw')
                        loadRawContent('sandbox')
                      }}
                      className="h-7 gap-1.5 px-2 text-xs font-medium"
                      aria-pressed={editorMode === 'raw'}
                    >
                      <Code className="h-3 w-3" /> {t('editorToolbar.raw')}
                    </Button>
                  </div>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => handleCreateBackup('sandbox')} aria-label={t('editorToolbar.downloadSandboxAria')}>
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('editorToolbar.downloadSandboxTooltip')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <a
                    href="https://pzwiki.net/wiki/Sandbox_options"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-7 items-center gap-1 rounded border border-border/60 bg-muted/30 px-2 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-primary"
                  >
                    <ExternalLink className="h-3 w-3" /> {t('editorToolbar.wiki')}
                  </a>
                  <Button onClick={handleSaveSandbox} disabled={saving || !hasSandboxChanges || invalidSandboxSettings.length > 0} variant="command" size="sm" className="h-7 gap-1.5 text-xs font-medium">
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    {t('editorToolbar.saveAndReload')}
                  </Button>
                </div>
              }
            />
            <div className="p-4">
              <Alert className="mb-3 border-primary/30 bg-primary/5">
                <AlertCircle className="h-4 w-4 text-primary" />
                <AlertTitle>{t('sandboxTab.build42Title')}</AlertTitle>
                <AlertDescription>
                  {t('sandboxTab.build42Body')}
                </AlertDescription>
              </Alert>
              {editorMode === 'raw' ? (
                <div className="relative">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="absolute top-2 right-2 z-10"
                          onClick={handleCopyRaw}
                        >
                          {copied ? (
                            <Check className="w-4 h-4 text-primary" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{copied ? t('editorToolbar.copied') : t('editorToolbar.copyToClipboard')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <Textarea
                    value={rawContent}
                    onChange={(e) => setRawContent(e.target.value)}
                    className="h-[calc(100vh-380px)] min-h-[400px] resize-y font-mono text-sm"
                    spellCheck={false}
                  />
                </div>
              ) : (
                <div className="min-h-[400px]">
                  {/* Scoped search — applies to all categories on this tab */}
                  <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="relative min-w-0 flex-1 sm:max-w-md">
                      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        ref={sandboxSearchRef}
                        placeholder={t('search.sandboxPlaceholder')}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="h-8 bg-background/50 ps-9 pe-20"
                        aria-label={t('search.sandboxAria')}
                        maxLength={128}
                      />
                      {searchQuery && (
                        <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
                          <span className="text-[11px] tabular-nums text-muted-foreground">
                            {searchResultsCount}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="pointer-events-auto h-6 w-6 p-0"
                            onClick={() => setSearchQuery('')}
                            aria-label={t('search.clearAria')}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="ms-auto flex items-center gap-2">
                      <div className="inline-flex items-center rounded-md border border-border/60 bg-background/50 p-0.5" role="group" aria-label={t('search.filterAria')}>
                        {(['all','modified','nondefault'] as const).map(mode => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setFilterMode(mode)}
                            className={`h-7 px-2.5 text-xs font-medium rounded transition-colors ${
                              filterMode === mode
                                ? 'bg-primary/15 text-primary'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {mode === 'nondefault' ? t('search.filterUnsaved') : mode === 'modified' ? t('search.filterModified') : t('search.filterAll')}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {searchQuery ? (
                    // Search mode: flat, grouped by category label
                    <ScrollArea className="h-[calc(100vh-420px)] min-h-[360px] pe-4">
                      {SANDBOX_CATEGORIES.map(category => {
                        const settings = filteredSandboxSettings[category.id] || []
                        if (settings.length === 0) return null
                        return (
                          <div key={category.id} className="mb-5">
                            <div className="sticky top-0 z-10 -mx-1 mb-2 flex items-baseline gap-2 bg-card/95 px-1 py-1.5 backdrop-blur">
                              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                {getSandboxCategoryLabel(category)}
                              </span>
                              <span className="text-[10px] text-muted-foreground/70">
                                {t('categoriesNav.matchCount', { count: settings.length })}
                              </span>
                            </div>
                            <div className="space-y-1">
                              {settings.map(setting => (
                                <SandboxSettingRow
                                  key={`${setting.section || 'settings'}.${setting.key}`}
                                  setting={setting}
                                  value={(sandboxData?.[(setting.section || 'settings') as keyof SandboxData] as SandboxRecord)?.[setting.key]}
                                  originalValue={(originalSandboxData?.[(setting.section || 'settings') as keyof SandboxData] as SandboxRecord)?.[setting.key]}
                                  onChange={updateSandboxValue}
                                  onReset={resetSandboxValue}
                                />
                              ))}
                            </div>
                          </div>
                        )
                      })}
                      {searchResultsCount === 0 && (
                        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                          {t('search.noMatches', { query: searchQuery })}
                        </div>
                      )}
                    </ScrollArea>
                  ) : (
                    // Rail mode: vertical category nav (grouped) + single active category content
                    <div className="grid gap-0 md:grid-cols-[252px_minmax(0,1fr)]">
                      <nav
                        aria-label={t('categoriesNav.sandboxAria')}
                        className="-mx-2 flex flex-col gap-0.5 px-2 pb-2 md:mx-0 md:order-1 md:border-e md:border-border/50 md:pb-0 md:pe-3 md:pt-1 md:max-h-[calc(100vh-420px)] md:min-h-[360px] md:overflow-y-auto"
                      >
                        <div className="hidden md:flex items-center justify-between px-3 pb-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                            {t('categoriesNav.categoriesLabel')}
                          </span>
                          <button
                            type="button"
                            onClick={() => setAllGroupsCollapsed('sandbox', !sandboxAllCollapsed)}
                            className="inline-flex items-center gap-1 rounded text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 hover:text-foreground transition-colors"
                            aria-label={sandboxAllCollapsed ? t('categoriesNav.expandAllAria') : t('categoriesNav.collapseAllAria')}
                          >
                            {sandboxAllCollapsed
                              ? <ChevronsUpDown className="h-3 w-3" />
                              : <ChevronsDownUp className="h-3 w-3" />}
                            <span>{sandboxAllCollapsed ? t('categoriesNav.expandAll') : t('categoriesNav.collapseAll')}</span>
                          </button>
                        </div>
                        {SANDBOX_CATEGORY_GROUPS.map((group, gIdx) => {
                          const groupLabel = getSandboxCategoryGroupLabel(group)
                          const cats = SANDBOX_CATEGORIES.filter(c => c.group === group.id)
                          const totalInGroup = cats.reduce((acc, c) => acc + (filteredSandboxSettings[c.id] || []).length, 0)
                          if (totalInGroup === 0 && filterMode !== 'all') return null
                          const groupKey = `sandbox:${group.id}`
                          const isCollapsed = !!collapsedGroups[groupKey]
                          const groupModCount = cats.reduce((acc, c) => acc + (sandboxModifiedByCategory[c.id] || 0), 0)
                          return (
                            <div key={group.id} className={`shrink-0 md:shrink ${gIdx > 0 ? 'mt-2 md:mt-3' : ''}`}>
                              <button
                                type="button"
                                onClick={() => toggleGroup(groupKey)}
                                aria-expanded={!isCollapsed}
                                className="hidden md:flex w-full items-center gap-2 px-3 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-foreground/80 hover:text-foreground transition-colors"
                              >
                                {isCollapsed
                                  ? <ChevronRight className="h-3 w-3 shrink-0" />
                                  : <ChevronDown className="h-3 w-3 shrink-0" />
                                }
                                <span>{groupLabel}</span>
                                {groupModCount > 0 && (
                                  <span className="rounded-full bg-warning/20 px-1.5 py-0.5 text-[8px] font-semibold text-warning">{groupModCount}</span>
                                )}
                                <span className="h-px flex-1 bg-border/40" />
                              </button>
                              {!isCollapsed && cats.map(category => {
                                const count = (filteredSandboxSettings[category.id] || []).length
                                if (count === 0 && filterMode !== 'all') return null
                                const isActive = activeSandboxCategory === category.id
                                const modCount = sandboxModifiedByCategory[category.id] || 0
                                return (
                                  <button
                                    key={category.id}
                                    type="button"
                                    onClick={() => setActiveSandboxCategory(category.id)}
                                    aria-current={isActive ? 'page' : undefined}
                                    className={`group relative flex shrink-0 items-center gap-2 whitespace-nowrap border-s-2 px-3 py-2 text-start text-sm transition-colors md:whitespace-normal ${
                                      isActive
                                        ? 'border-primary bg-primary/10 text-primary'
                                        : 'border-transparent text-muted-foreground hover:border-primary/30 hover:bg-muted/40 hover:text-foreground'
                                    }`}
                                  >
                                    <CategoryIcon name={category.icon} isActive={isActive} className="h-4 w-4 shrink-0" />
                                    <span className="min-w-0 flex-1 truncate font-medium" title={getSandboxCategoryLabel(category)}>{getSandboxCategoryLabel(category)}</span>
                                    {modCount > 0 && (
                                      <span
                                        className="shrink-0 rounded-full bg-warning/20 px-1.5 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wider text-warning"
                                        title={t('categoriesNav.modifiedCountTitle', { count: modCount })}
                                      >
                                        {modCount}
                                      </span>
                                    )}
                                    <span className={`shrink-0 min-w-[1.5rem] rounded text-center px-1 py-0.5 text-[10px] font-mono tabular-nums ${
                                      isActive ? 'text-primary/80' : 'bg-muted text-muted-foreground'
                                    }`}>
                                      {count}
                                    </span>
                                  </button>
                                )
                              })}
                            </div>
                          )
                        })}
                        {uncategorizedSandboxKeys.length > 0 && (() => {
                          const isActive = activeSandboxCategory === 'uncategorized'
                          return (
                            <button
                              key="uncategorized"
                              type="button"
                              onClick={() => setActiveSandboxCategory('uncategorized')}
                              aria-current={isActive ? 'page' : undefined}
                              className={`group relative mt-2 flex shrink-0 items-center gap-2 whitespace-nowrap border-s-2 px-3 py-2 text-start text-sm transition-colors md:mt-3 md:whitespace-normal md:border-t md:border-t-border/50 md:pt-3 ${
                                isActive
                                  ? 'border-s-amber-500 bg-amber-500/10 text-amber-500'
                                  : 'border-s-transparent text-muted-foreground hover:border-s-amber-500/30 hover:bg-amber-500/5 hover:text-amber-500/80'
                              }`}
                              title={t('categoriesNav.uncategorizedSandboxTitle')}
                            >
                              <span className="min-w-0 flex-1 truncate font-medium">{t('categoriesNav.uncategorizedSandboxLabel')}</span>
                              <span className={`shrink-0 min-w-[1.5rem] rounded text-center px-1 py-0.5 text-[10px] font-mono tabular-nums ${
                                isActive ? 'text-amber-500/80' : 'bg-muted text-muted-foreground'
                              }`}>
                                {uncategorizedSandboxKeys.length}
                              </span>
                            </button>
                          )
                        })()}
                      </nav>
                      <ScrollArea className="h-[calc(100vh-420px)] min-h-[360px] md:ps-5 pe-4 md:order-2">
                        {(() => {
                          if (activeSandboxCategory === 'uncategorized') {
                            if (uncategorizedSandboxKeys.length === 0) {
                              return (
                                <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                                  {t('uncategorizedSandbox.empty')}
                                </div>
                              )
                            }
                            return (
                              <div>
                                <div className="sticky top-0 z-10 -mx-1 mb-3 flex items-baseline justify-between border-b border-amber-500/30 bg-card/95 px-1 pb-2 pt-1 backdrop-blur">
                                  <h3 className="text-sm font-semibold uppercase tracking-wider text-amber-500">
                                    {t('uncategorizedSandbox.heading')}
                                  </h3>
                                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                                    {t('uncategorizedSandbox.keyCount', { count: uncategorizedSandboxKeys.length })}
                                  </span>
                                </div>
                                <p className="mb-3 text-xs text-muted-foreground">
                                  {t('uncategorizedSandbox.description')}
                                </p>
                                <div className="space-y-5">
                                  {Object.entries(uncategorizedGroups).map(([groupName, groupEntries]) => (
                                    <div key={groupName}>
                                      <div className="mb-1.5 flex items-baseline justify-between border-b border-border/40 pb-1">
                                        <h4 className="font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                          {groupName === 'settings' ? t('uncategorizedSandbox.mainSection') : groupName}
                                        </h4>
                                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{groupEntries.length}</span>
                                      </div>
                                      <div className="space-y-1">
                                        {groupEntries.map(({ section, key, value }) => {
                                    const origSection = originalSandboxData?.[section as keyof SandboxData]
                                    const origValue = typeof origSection === 'object' ? (origSection as Record<string, unknown>)?.[key] : undefined
                                    const isModified = value !== origValue
                                    return (
                                      <div key={`${section}.${key}`} className={`flex items-center justify-between py-2 px-3 rounded-md transition-colors ${isModified ? 'bg-amber-500/10 border border-amber-500/20' : 'hover:bg-muted/50'}`}>
                                        <div className="flex-1 min-w-0 me-4">
                                          <div className="flex items-center gap-2 min-w-0">
                                            <span className="text-sm font-medium truncate" title={key}>{key}</span>
                                            {isModified && (
                                              <button
                                                onClick={() => {
                                                  if (origValue !== undefined) {
                                                    setSandboxData(prev => {
                                                      if (!prev) return prev
                                                      const s = { ...(prev[section as keyof SandboxData] as Record<string, unknown> || {}) }
                                                      s[key] = origValue
                                                      return { ...prev, [section]: s } as SandboxData
                                                    })
                                                  }
                                                }}
                                                className="text-xs text-amber-500 hover:text-amber-400"
                                                title={t('uncategorizedSandbox.undoTitle')}
                                                aria-label={t('uncategorizedSandbox.undoTitle')}
                                              >↩</button>
                                            )}
                                          </div>
                                        </div>
                                        <Input
                                          className="w-48 h-8 text-sm flex-shrink-0"
                                          value={String(value)}
                                          maxLength={500}
                                          onChange={e => {
                                            const raw = e.target.value
                                            let parsed: string | number | boolean = raw
                                            if (raw === 'true') parsed = true
                                            else if (raw === 'false') parsed = false
                                            else if (raw !== '' && !isNaN(Number(raw))) parsed = Number(raw)
                                            setSandboxData(prev => {
                                              if (!prev) return prev
                                              const s = { ...(prev[section as keyof SandboxData] as Record<string, unknown> || {}) }
                                              s[key] = parsed
                                              return { ...prev, [section]: s } as SandboxData
                                            })
                                          }}
                                        />
                                      </div>
                                    )
                                        })}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )
                          }
                          const settings = filteredSandboxSettings[activeSandboxCategory] || []
                          const active = SANDBOX_CATEGORIES.find(c => c.id === activeSandboxCategory)
                          if (settings.length === 0) {
                            return (
                              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                                {filterMode === 'modified' ? t('categoryContent.noneModified') :
                                 filterMode === 'nondefault' ? t('categoryContent.noneUnsaved') :
                                 t('categoryContent.none')}
                              </div>
                            )
                          }
                          return (
                            <div>
                              <div className="sticky top-0 z-10 -mx-1 mb-3 flex items-baseline justify-between border-b border-border/50 bg-card/95 px-1 pb-2 pt-1 backdrop-blur">
                                <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">
                                  {active ? getSandboxCategoryLabel(active) : null}
                                </h3>
                                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                                  {t('categoryContent.settingCount', { count: settings.length })}
                                </span>
                              </div>
                              <div className="space-y-1">
                                {settings.map(setting => (
                                  <SandboxSettingRow
                                    key={`${setting.section || 'settings'}.${setting.key}`}
                                    setting={setting}
                                    value={(sandboxData?.[(setting.section || 'settings') as keyof SandboxData] as SandboxRecord)?.[setting.key]}
                                    originalValue={(originalSandboxData?.[(setting.section || 'settings') as keyof SandboxData] as SandboxRecord)?.[setting.key]}
                                    onChange={updateSandboxValue}
                                    onReset={resetSandboxValue}
                                  />
                                ))}
                              </div>
                            </div>
                          )
                        })()}
                      </ScrollArea>
                    </div>
                  )}
                </div>
              )}
            </div>
          </TacticalPanel>
        </TabsContent>

        {/* Spawn Points Tab */}
        <TabsContent value="spawnpoints" className="mt-4">
          <TacticalPanel tone="muted">
            <SectionHeader
              label={t('spawnPointsTab.sectionLabel')}
              sublabel={t('spawnPointsTab.sectionSublabel')}
              icon={MapPin}
              tone="muted"
              action={
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 p-0.5">
                    <Button
                      variant={editorMode === 'structured' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => setEditorMode('structured')}
                      className="h-7 gap-1.5 px-2 text-xs font-medium"
                      aria-pressed={editorMode === 'structured'}
                    >
                      <FormInput className="h-3 w-3" /> {t('spawnPointsTab.infoTab')}
                    </Button>
                    <Button
                      variant={editorMode === 'raw' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        setEditorMode('raw')
                        loadRawContent('spawnpoints')
                      }}
                      className="h-7 gap-1.5 px-2 text-xs font-medium"
                      aria-pressed={editorMode === 'raw'}
                    >
                      <Code className="h-3 w-3" /> {t('editorToolbar.raw')}
                    </Button>
                  </div>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => handleCreateBackup('spawnpoints')} aria-label={t('editorToolbar.downloadSpawnPointsAria')}>
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('editorToolbar.downloadSpawnPointsTooltip')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <a
                    href="https://map.projectzomboid.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-7 items-center gap-1 rounded border border-border/60 bg-muted/30 px-2 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-primary"
                  >
                    <ExternalLink className="h-3 w-3" /> {t('editorToolbar.map')}
                  </a>
                  {editorMode === 'raw' && (
                    <Button onClick={handleSaveSpawnPoints} disabled={saving} variant="command" size="sm" className="h-7 gap-1.5 text-xs font-medium">
                      {saving ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Save className="h-3 w-3" />
                      )}
                      {t('editorToolbar.save')}
                    </Button>
                  )}
                </div>
              }
            />
            <div className="p-4">
              {editorMode === 'raw' ? (
                <div className="relative">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="absolute top-2 right-2 z-10"
                          onClick={handleCopyRaw}
                        >
                          {copied ? (
                            <Check className="w-4 h-4 text-primary" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{copied ? t('editorToolbar.copied') : t('editorToolbar.copyToClipboard')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <Textarea
                    value={rawContent}
                    onChange={(e) => setRawContent(e.target.value)}
                    className="h-[400px] resize-y font-mono text-sm"
                    spellCheck={false}
                  />
                </div>
              ) : (
                <div className="text-center py-16">
                  <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
                    <MapPin className="w-8 h-8" />
                  </div>
                  <h3 className="text-lg font-medium mb-2">{t('spawnPointsTab.modManagedTitle')}</h3>
                  <p className="text-muted-foreground max-w-md mx-auto text-sm">
                    <Trans i18nKey="spawnPointsTab.modManagedBody" t={t} components={{ 1: <strong /> }} />
                  </p>
                  <div className="mt-6">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setEditorMode('raw')
                        loadRawContent('spawnpoints')
                      }}
                      className="gap-1.5 text-xs font-medium"
                    >
                      <Code className="h-3.5 w-3.5" /> {t('spawnPointsTab.openRawFile')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </TacticalPanel>
        </TabsContent>

        {/* Spawn Regions Tab */}
        <TabsContent value="spawnregions" className="mt-4">
          <TacticalPanel tone="primary">
            <SectionHeader
              label={t('spawnRegionsTab.sectionLabel')}
              sublabel={t('spawnRegionsTab.sectionSublabel', { count: spawnRegions.length })}
              icon={Map}
              action={
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 p-0.5">
                    <Button
                      variant={editorMode === 'structured' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => setEditorMode('structured')}
                      className="h-7 gap-1.5 px-2 text-xs font-medium"
                      aria-pressed={editorMode === 'structured'}
                    >
                      <FormInput className="h-3 w-3" /> {t('editorToolbar.form')}
                    </Button>
                    <Button
                      variant={editorMode === 'raw' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        setEditorMode('raw')
                        loadRawContent('spawnregions')
                      }}
                      className="h-7 gap-1.5 px-2 text-xs font-medium"
                      aria-pressed={editorMode === 'raw'}
                    >
                      <Code className="h-3 w-3" /> {t('editorToolbar.raw')}
                    </Button>
                  </div>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => handleCreateBackup('spawnregions')} aria-label={t('editorToolbar.downloadSpawnRegionsAria')}>
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('editorToolbar.downloadSpawnRegionsTooltip')}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <Button onClick={handleSaveSpawnRegions} disabled={saving} variant="command" size="sm" className="h-7 gap-1.5 text-xs font-medium">
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    {t('editorToolbar.save')}
                  </Button>
                </div>
              }
            />
            <div className="p-4">
              {editorMode === 'raw' ? (
                <Textarea
                  value={rawContent}
                  onChange={(e) => setRawContent(e.target.value)}
                  className="h-[400px] resize-y font-mono text-sm"
                  spellCheck={false}
                />
              ) : (
                <div className="space-y-3">
                  {spawnRegions.length === 0 ? (
                    <EmptyState type="noData" title={t('spawnRegionsTab.noRegionsTitle')} description={t('spawnRegionsTab.noRegionsDesc')} compact />
                  ) : (
                    <div className="overflow-hidden rounded-lg border">
                      {/* Column headers (sm+ only) */}
                      <div className="hidden sm:grid grid-cols-[2rem_minmax(180px,260px)_minmax(0,1fr)_2.25rem] items-center gap-3 border-b bg-muted/30 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        <span className="text-center">#</span>
                        <span>{t('spawnRegionsTab.columnDisplayName')}</span>
                        <span className="flex items-center gap-1">
                          {t('spawnRegionsTab.columnMapFilePath')}
                          <HelpTip label={t('spawnRegionsTab.columnMapFilePath')}>{t('spawnRegionsTab.mapFilePathTip')}</HelpTip>
                        </span>
                        <span aria-hidden="true" />
                      </div>
                      <ul className="divide-y divide-border/60">
                        {spawnRegions.map((region, index) => (
                          <li
                            key={index}
                            className="grid grid-cols-1 gap-3 px-3 py-2.5 sm:grid-cols-[2rem_minmax(180px,260px)_minmax(0,1fr)_2.25rem] sm:items-center"
                          >
                            <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border bg-muted/40 px-1.5 text-xs font-mono font-medium text-muted-foreground sm:justify-self-center">
                              {index + 1}
                            </span>
                            <div className="min-w-0">
                              <Label className="sm:sr-only text-[10px] uppercase tracking-wide text-muted-foreground">{t('spawnRegionsTab.columnDisplayName')}</Label>
                              <Input
                                value={region.name}
                                onChange={(e) => {
                                  const newRegions = [...spawnRegions]
                                  newRegions[index] = { ...region, name: e.target.value }
                                  setSpawnRegions(newRegions)
                                }}
                                placeholder={t('spawnRegionsTab.displayNamePlaceholder')}
                                maxLength={64}
                                className="mt-0.5 h-9 sm:mt-0"
                                aria-label={t('spawnRegionsTab.displayNameAria', { index: index + 1 })}
                              />
                            </div>
                            <div className="min-w-0">
                              <Label className="sm:sr-only text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                                {region.isServerFile ? t('spawnRegionsTab.serverFileLabel') : t('spawnRegionsTab.columnMapFilePath')}
                                {region.isServerFile && (
                                  <Badge variant="secondary" className="text-[10px] py-0">{t('spawnRegionsTab.serverFileBadge')}</Badge>
                                )}
                              </Label>
                              <div className="relative mt-0.5 sm:mt-0">
                                <Input
                                  value={region.file}
                                  onChange={(e) => {
                                    const newRegions = [...spawnRegions]
                                    newRegions[index] = { ...region, file: e.target.value }
                                    setSpawnRegions(newRegions)
                                  }}
                                  placeholder={region.isServerFile ? t('spawnRegionsTab.serverFilePlaceholder') : t('spawnRegionsTab.mapFilePlaceholder')}
                                  className={`h-9 font-mono text-xs ${region.isServerFile ? 'pe-20' : ''}`}
                                  maxLength={512}
                                  aria-label={region.isServerFile ? t('spawnRegionsTab.fileAriaServerFile', { index: index + 1 }) : t('spawnRegionsTab.fileAriaMapPath', { index: index + 1 })}
                                />
                                {region.isServerFile && (
                                  <Badge variant="secondary" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] py-0">
                                    {t('spawnRegionsTab.serverFileBadge')}
                                  </Badge>
                                )}
                              </div>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 justify-self-end text-muted-foreground hover:text-destructive sm:justify-self-center"
                              onClick={() => setSpawnRegions(spawnRegions.filter((_, i) => i !== index))}
                              aria-label={t('spawnRegionsTab.deleteAria', { name: region.name || index + 1 })}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="flex justify-end pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSpawnRegions([...spawnRegions, { name: '', file: 'media/maps/' }])}
                      className="gap-1.5 text-xs font-medium"
                    >
                      <Plus className="h-3.5 w-3.5" /> {t('spawnRegionsTab.addRegion')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </TacticalPanel>
        </TabsContent>

        {/* Mod Settings Tab (Live from PanelBridge) */}
        <TabsContent value="modsettings" className="mt-4">
          <TacticalPanel tone={modifiedModSettingsCount > 0 ? 'warning' : 'info'}>
            <SectionHeader
              label={t('modSettingsTab.sectionLabel')}
              sublabel={modSettings ? t('modSettingsTab.sectionSublabelLoaded', { count: modSettingsGroups.length }) : t('modSettingsTab.sectionSublabelIdle')}
              icon={Puzzle}
              tone={modifiedModSettingsCount > 0 ? 'warning' : 'info'}
              action={
                <div className="flex flex-wrap items-center gap-1.5">
                  {modifiedModSettingsCount > 0 && (
                    <Badge variant="warning" className="h-5 px-1.5 py-0 font-mono text-[10px]">
                      {t('modSettingsTab.modifiedBadge', { count: modifiedModSettingsCount })}
                    </Badge>
                  )}
                  <Button
                    variant="command"
                    size="sm"
                    onClick={loadModSettings}
                    disabled={modSettingsLoading}
                    className="h-7 gap-1.5 text-xs font-medium"
                  >
                    {modSettingsLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    {modSettings ? t('modSettingsTab.refresh') : t('modSettingsTab.load')}
                  </Button>
                </div>
              }
            />
            <div className="p-4">
              {modSettings && modSettingsGroups.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      ref={modSettingsSearchRef}
                      placeholder={t('modSettingsTab.searchPlaceholder')}
                      value={modSettingsSearch}
                      onChange={(e) => setModSettingsSearch(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Escape') { setModSettingsSearch(''); e.currentTarget.blur() } }}
                      className="ps-9 pe-8"
                      maxLength={200}
                    />
                    {modSettingsSearch && (
                      <button
                        onClick={() => setModSettingsSearch('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t('modSettingsTab.clearSearchAria')}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <DisabledReason reason={modifiedModSettingsCount === 0 && !modSettingsModifiedOnly ? t('modSettingsTab.modifiedFilterNoneTitle') : null}>
                    <Button
                      variant={modSettingsModifiedOnly ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setModSettingsModifiedOnly(v => !v)}
                      disabled={modifiedModSettingsCount === 0 && !modSettingsModifiedOnly}
                      className="shrink-0 h-9 gap-1.5 text-xs font-medium"
                      aria-pressed={modSettingsModifiedOnly}
                      // eslint-disable-next-line local/no-dead-disabled-title -- split 2026-08-27: the disabled-reason branch (no modified options) now lives in the DisabledReason wrapper above; this title carries only the enabled-state hint.
                      title={t('modSettingsTab.modifiedFilterTitle')}
                    >
                      <Filter className="w-3.5 h-3.5" />
                      {t('modSettingsTab.modifiedFilter')}
                      {modifiedModSettingsCount > 0 && (
                        <Badge variant={modSettingsModifiedOnly ? 'secondary' : 'warning'} className="ms-0.5 h-4 px-1.5 py-0 text-xs">
                          {modifiedModSettingsCount}
                        </Badge>
                      )}
                    </Button>
                  </DisabledReason>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const allVisible = filteredModGroups.length > 0 && filteredModGroups.every(g => expandedModGroups.has(g.name))
                      if (allVisible) {
                        setExpandedModGroups(new Set())
                      } else {
                        setExpandedModGroups(new Set(filteredModGroups.map(g => g.name)))
                      }
                    }}
                    className="shrink-0 gap-1.5 text-xs font-medium"
                  >
                    {filteredModGroups.length > 0 && filteredModGroups.every(g => expandedModGroups.has(g.name)) ? (
                      <><ChevronDown className="w-3.5 h-3.5" /> {t('modSettingsTab.collapseAll')}</>
                    ) : (
                      <><ChevronRight className="w-3.5 h-3.5" /> {t('modSettingsTab.expandAll')}</>
                    )}
                  </Button>
                </div>
              )}
              {!modSettings && !modSettingsLoading && !modSettingsError && (
                <EmptyState
                  type="noMods"
                  title={t('modSettingsTab.notLoadedTitle')}
                  description={
                    <span>
                      {t('modSettingsTab.notLoadedDescPrefix')}
                      <HelpTip label={t('modSettingsTab.panelBridgeLabel')} side="bottom" className="mx-1 align-[-2px]">
                        {t('modSettingsTab.panelBridgeTip')}
                      </HelpTip>
                      {t('modSettingsTab.notLoadedDescSuffix')}
                    </span>
                  }
                />
              )}

              {modSettingsError && (
                <Alert variant={modSettings ? 'default' : 'destructive'} className="mb-3">
                  <AlertCircle className="w-4 h-4" />
                  <AlertTitle>{modSettings ? t('modSettingsTab.refreshFailedTitle') : t('modSettingsTab.loadFailedTitle')}</AlertTitle>
                  <AlertDescription className="flex items-center justify-between gap-3">
                    <span className="break-words min-w-0">{modSettingsError}</span>
                    <Button variant="outline" size="sm" onClick={loadModSettings} disabled={modSettingsLoading} className="shrink-0 gap-1.5">
                      <RefreshCw className="w-3.5 h-3.5" /> {t('modSettingsTab.retry')}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}

              {modSettingsLoading && (
                <div className="flex items-center justify-center py-12 gap-3 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>{t('modSettingsTab.loadingOptions')}</span>
                </div>
              )}

              {modSettings && modSettingsGroups.length === 0 && !modSettingsLoading && (
                <EmptyState
                  type="noMods"
                  title={t('modSettingsTab.noOptionsTitle')}
                  description={t('modSettingsTab.noOptionsDesc')}
                />
              )}

              {modSettings && modSettingsGroups.length > 0 && (
                <ScrollArea className="h-[calc(100vh-440px)] min-h-[400px] pe-4">
                  <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                    <Badge variant="secondary">
                      {modSettingsSearch || modSettingsModifiedOnly ? `${filteredModGroups.length} / ${modSettingsGroups.length}` : modSettingsGroups.length} {t('modSettingsTab.groupsBadge')}
                    </Badge>
                    <Badge variant="secondary">
                      {modSettingsSearch || modSettingsModifiedOnly
                        ? `${filteredModGroups.reduce((s, g) => s + g.filteredOpts.length, 0)} / ${modSettingsGroups.reduce((s, g) => s + g.count, 0)}`
                        : modSettingsGroups.reduce((s, g) => s + g.count, 0)
                      } {t('modSettingsTab.optionsBadge')}
                    </Badge>
                    {modifiedModSettingsCount > 0 && (
                      <Badge variant="warning" className="gap-1" title={t('modSettingsTab.modifiedBadgeTitle')}>
                        <AlertTriangle className="w-3 h-3" />
                        {t('modSettingsTab.modifiedBadge', { count: modifiedModSettingsCount })}
                      </Badge>
                    )}
                    {modSettingsLastLoaded && (
                      <span className="text-xs text-muted-foreground/60 ms-auto">
                        {t('modSettingsTab.loadedAt', { time: modSettingsLastLoaded.toLocaleTimeString(i18n.language) })}
                      </span>
                    )}
                  </div>
                  {filteredModGroups
                    .map(group => {
                      // When the user is actively filtering, force groups open so matches
                      // are immediately visible (otherwise hits hide behind collapsed headers).
                      const isFiltering = !!modSettingsSearch.trim() || modSettingsModifiedOnly
                      const isExpanded = isFiltering || expandedModGroups.has(group.name)
                      const filteredOpts = group.filteredOpts
                      // Modified count for this whole group (not just visible/filtered)
                      const groupAllOpts = modSettings[group.name] || []
                      const groupModifiedCount = groupAllOpts.reduce((c, o) => c + (isOptModified(o) ? 1 : 0), 0)

                      return (
                        <div key={group.name} className="mb-3">
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedModGroups(prev => {
                                const next = new Set(prev)
                                if (next.has(group.name)) next.delete(group.name)
                                else next.add(group.name)
                                return next
                              })
                            }}
                            aria-expanded={isExpanded}
                            className={`flex items-center gap-3 w-full py-2.5 px-4 rounded-lg transition-[background-color,border-color,box-shadow,color] duration-200 ${
                              isExpanded
                                ? 'border border-primary/30 bg-primary/10 shadow-sm'
                                : 'bg-muted/50 hover:bg-muted border border-transparent'
                            }`}
                          >
                            <div className={`p-1 rounded transition-colors ${isExpanded ? 'bg-primary/20 text-primary' : 'bg-muted'}`}>
                              {isExpanded ? (
                                <ChevronDown className="w-4 h-4" />
                              ) : (
                                <ChevronRight className="w-4 h-4" />
                              )}
                            </div>
                            <span className={`font-medium truncate min-w-0 ${isExpanded ? 'text-primary' : ''}`} title={formatModSettingLabel(group.name)}>{formatModSettingLabel(group.name)}</span>
                            {groupModifiedCount > 0 && (
                              <Badge variant="warning" className="h-5 px-1.5 py-0 text-[10px] font-mono shrink-0" title={t('modSettingsTab.groupModifiedTitle', { count: groupModifiedCount })}>
                                {t('modSettingsTab.groupModifiedBadge', { count: groupModifiedCount })}
                              </Badge>
                            )}
                            <Badge variant={isExpanded ? "default" : "secondary"} className="ms-auto">
                              {filteredOpts.length}
                            </Badge>
                          </button>
                          {isExpanded && (
                            <div className="mt-3 ms-4 space-y-1 ps-4">
                              {filteredOpts.map((opt, idx) => {
                                // Mods often expose an internal sandbox key as their
                                // "translated" name. Format it before displaying it.
                                const rawDisplayName = opt.shortName || opt.name || `Option ${idx}`
                                const displayName = formatModSettingLabel(
                                  opt.translatedName && opt.translatedName !== rawDisplayName ? opt.translatedName : rawDisplayName,
                                  group.name,
                                ) || `Option ${idx + 1}`
                                // Keep player-facing help, but hide untranslated tooltip keys.
                                const rawTooltip = opt.tooltipText || opt.tooltip || ''
                                const description = formatModSettingDescription(rawTooltip.replace(/\n?Default\s*=\s*.*/i, ''))
                                const rawVal = opt.value
                                let displayValue: string
                                if (rawVal === undefined || rawVal === null) {
                                  displayValue = '—'
                                } else if (typeof rawVal === 'number') {
                                  displayValue = Number.isInteger(rawVal) ? String(rawVal) : rawVal.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
                                } else {
                                  displayValue = String(rawVal)
                                }
                                const typeLabel = opt.type || 'unknown'
                                const boolValue = typeLabel === 'boolean'
                                  ? (rawVal === true || rawVal === 'true' || rawVal === 1)
                                  : false
                                const isSaving = opt.name ? savingOptions.has(opt.name) : false
                                const isModified = isOptModified(opt)

                                return (
                                  <div
                                    key={`${opt.name || 'opt'}-${idx}`}
                                    className={`flex items-center justify-between py-2 px-3 rounded-md hover:bg-muted/50 gap-4 ${isSaving ? 'opacity-60 pointer-events-none' : ''}`}
                                  >
                                    <div className="flex-1 min-w-0">
                                      <div className="font-medium text-sm truncate" title={opt.name || displayName}>
                                        {displayName}
                                      </div>
                                      {description && (
                                        <div className="text-xs text-muted-foreground/70 mt-0.5 line-clamp-2" title={rawTooltip}>
                                          {description}
                                        </div>
                                      )}
                                      {opt.name && opt.name !== displayName && (
                                        <div className="text-[10px] text-muted-foreground/40 font-mono truncate mt-0.5" title={opt.name}>{opt.name}</div>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                      {typeLabel === 'boolean' ? (
                                        <div className="flex items-center gap-2">
                                          <Switch
                                            checked={boolValue}
                                            onCheckedChange={(checked) => opt.name && !isSaving && handleOptionChange(opt.name, checked, group.name)}
                                            disabled={isSaving}
                                            aria-label={t('modSettingsTab.toggleAria', { label: displayName, state: boolValue ? t('modSettingsTab.onCaps') : t('modSettingsTab.offCaps') })}
                                          />
                                          <span className={`text-xs font-mono ${boolValue ? 'text-primary' : 'text-muted-foreground'}`}>
                                            {boolValue ? t('modSettingsTab.onCaps') : t('modSettingsTab.offCaps')}
                                          </span>
                                        </div>
                                      ) : typeLabel === 'enum' && opt.enumValues && opt.enumValues.length > 0 ? (
                                        <Select
                                          value={opt.selectedIndex !== undefined ? String(opt.selectedIndex) : displayValue}
                                          onValueChange={(val) => {
                                            if (!opt.name || isSaving) return
                                            const idx = parseInt(val, 10)
                                            if (isNaN(idx)) return
                                            handleOptionChange(opt.name, idx, group.name)
                                          }}
                                          disabled={isSaving}
                                        >
                                          <SelectTrigger className="h-7 w-full sm:w-[180px] text-xs font-mono" aria-label={displayName}>
                                            <SelectValue />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {opt.enumValues.map((ev, ei) => (
                                              <SelectItem key={ei} value={String(ei)} className="text-xs font-mono">
                                                {ev}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                      ) : typeLabel === 'number' || typeLabel === 'double' || typeLabel === 'integer' ? (
                                        <Input
                                          key={`${opt.name}-${displayValue}`}
                                          type="number"
                                          className="h-7 w-full sm:w-[100px] text-xs font-mono text-end"
                                          defaultValue={displayValue}
                                          min={opt.min}
                                          max={opt.max}
                                          // The browser counts valid values up from `min` in `step`
                                          // increments, so a fractional min like 0.001 with step 1
                                          // rejects every whole number the user types.
                                          step={typeLabel === 'integer' && Number.isInteger(opt.min ?? 0) ? 1 : 'any'}
                                          disabled={isSaving}
                                          aria-label={displayName}
                                          onBlur={(e) => {
                                            let num = parseFloat(e.target.value)
                                            if (isNaN(num) || !opt.name) return
                                            if (opt.min !== undefined) num = Math.max(opt.min, num)
                                            if (opt.max !== undefined) num = Math.min(opt.max, num)
                                            if (num === rawVal) return
                                            e.target.value = String(num)
                                            handleOptionChange(opt.name, num, group.name)
                                          }}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                              (e.target as HTMLInputElement).blur()
                                            }
                                          }}
                                        />
                                      ) : (
                                        <Input
                                          key={`${opt.name}-${displayValue}`}
                                          type="text"
                                          className="h-7 w-full sm:w-[160px] text-xs font-mono"
                                          defaultValue={displayValue}
                                          disabled={isSaving}
                                          aria-label={displayName}
                                          onBlur={(e) => {
                                            if (e.target.value !== String(rawVal) && opt.name) {
                                              handleOptionChange(opt.name, e.target.value, group.name)
                                            }
                                          }}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                              (e.target as HTMLInputElement).blur()
                                            }
                                          }}
                                        />
                                      )}
                                      {opt.min !== undefined && opt.max !== undefined && (
                                        <span className="text-xs text-muted-foreground/60 whitespace-nowrap">
                                          {opt.min}–{opt.max}
                                        </span>
                                      )}
                                      {isModified && (
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <button
                                              type="button"
                                              className="text-xs text-muted-foreground/50 hover:text-primary whitespace-nowrap flex items-center gap-1"
                                              onClick={() => opt.name && opt.default !== undefined && handleOptionChange(opt.name, opt.default, group.name)}
                                              disabled={isSaving}
                                              // eslint-disable-next-line local/no-dead-disabled-title -- pure hint naming the action + value; disables only transiently while a save is in flight (the adjacent spinner is the self-evident why). Triaged 2026-08-27. Note: the wrapping Radix Tooltip here has the same "no pointer/focus events on a disabled native button" limitation as this title, so its content is equally unreachable while isSaving -- out of scope for this rule (it only checks title+disabled), flagged here rather than fixed since isSaving is brief and self-evident.
                                              title={t('modSettingsTab.resetToDefaultTitle', { value: formatRawConfigValue(opt.default) })}
                                            >
                                              <Undo2 className="w-3 h-3" />
                                              <span>{t('modSettingsTab.resetToDefaultLabel', { value: formatRawConfigValue(opt.default) })}</span>
                                            </button>
                                          </TooltipTrigger>
                                          <TooltipContent side="left">
                                            <p>{t('modSettingsTab.resetToDefaultTooltip', { value: formatRawConfigValue(opt.default) })}</p>
                                          </TooltipContent>
                                        </Tooltip>
                                      )}
                                      {isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  {filteredModGroups.length === 0 && (modSettingsSearch || modSettingsModifiedOnly) && (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
                      {modSettingsModifiedOnly && !modSettingsSearch ? (
                        <>
                          <Filter className="w-5 h-5 opacity-50" />
                          <p className="text-sm">{t('modSettingsTab.noModifiedOptions')}</p>
                          <Button variant="ghost" size="sm" onClick={() => setModSettingsModifiedOnly(false)} className="text-xs">
                            {t('modSettingsTab.showAllOptions')}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Search className="w-5 h-5 opacity-50" />
                          <p className="text-sm">{t('modSettingsTab.noMatches', { query: modSettingsSearch.length > 60 ? modSettingsSearch.slice(0, 60) + '…' : modSettingsSearch, suffix: modSettingsModifiedOnly ? t('modSettingsTab.noMatchesInModified') : '' })}</p>
                          <div className="flex gap-2">
                            {modSettingsSearch && (
                              <Button variant="ghost" size="sm" onClick={() => setModSettingsSearch('')} className="text-xs">
                                {t('modSettingsTab.clearSearch')}
                              </Button>
                            )}
                            {modSettingsModifiedOnly && (
                              <Button variant="ghost" size="sm" onClick={() => setModSettingsModifiedOnly(false)} className="text-xs">
                                {t('modSettingsTab.showAllOptions')}
                              </Button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </ScrollArea>
              )}
            </div>
          </TacticalPanel>
        </TabsContent>
      </Tabs>

      {/* Sticky save bar — appears when there are unsaved changes on the active tab */}
      {((activeTab === 'ini' && hasIniChanges) || (activeTab === 'sandbox' && hasSandboxChanges)) && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4 sm:px-6 sm:pb-5">
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto flex w-full max-w-3xl items-center gap-3 rounded-lg border border-warning/40 bg-card/95 px-4 py-2.5 shadow-lg shadow-black/30 backdrop-blur supports-[backdrop-filter]:bg-card/80 motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:fade-in"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-warning/15 text-warning">
              <AlertTriangle className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-foreground">
                {t('stickySaveBar.unsavedChange', { count: activeTab === 'ini' ? changedIniCount : changedSandboxCount })}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {activeTab === 'ini' ? t('stickySaveBar.iniScope') : t('stickySaveBar.sandboxScope')} · {t('stickySaveBar.hint')}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={activeTab === 'ini' ? discardIniChanges : discardSandboxChanges}
              disabled={saving || serverMayBeRunning}
              className="h-8 gap-1.5 text-xs font-medium text-muted-foreground hover:text-destructive"
            >
              <Undo2 className="h-3 w-3" /> {t('stickySaveBar.discard')}
            </Button>
            <Button
              variant="command"
              size="sm"
              onClick={activeTab === 'ini' ? handleSaveIni : handleSaveSandbox}
              disabled={saving || (activeTab === 'ini' ? invalidIniSettings.length > 0 : invalidSandboxSettings.length > 0)}
              className="h-8 gap-1.5 text-xs font-medium"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              {t('stickySaveBar.saveAndReload')}
            </Button>
          </div>
        </div>
      )}
      <Dialog open={showBackups} onOpenChange={setShowBackups}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="w-5 h-5" />
              {t('backupsDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {t('backupsDialog.description')}
            </DialogDescription>
          </DialogHeader>

          {/* Filter tabs */}
          <div className="flex items-center gap-2 border-b pb-3">
            <span className="text-sm text-muted-foreground me-2">
              <Filter className="w-4 h-4 inline me-1" />
              {t('backupsDialog.filterLabel')}
            </span>
            {(['all', 'ini', 'sandbox', 'spawnpoints', 'spawnregions'] as const).map((filter) => (
              <Button
                key={filter}
                variant={backupFilter === filter ? 'default' : 'outline'}
                size="sm"
                onClick={() => setBackupFilter(filter)}
                className="capitalize"
              >
                {filter === 'all' ? t('backupsDialog.filterAll') : filter}
              </Button>
            ))}
          </div>

          <ScrollArea className="h-[400px]">
            {backups.length === 0 ? (
              <EmptyState type="noData" title={t('backupsDialog.emptyTitle')} description={t('backupsDialog.emptyDesc')} compact />
            ) : (
              <div className="space-y-2">
                {backups
                  .filter(backup => {
                    if (backupFilter === 'all') return true
                    const filename = backup.filename.toLowerCase()
                    if (backupFilter === 'ini') return filename.includes('_ini_') || filename.endsWith('.ini')
                    if (backupFilter === 'sandbox') return filename.includes('sandbox')
                    if (backupFilter === 'spawnpoints') return filename.includes('spawnpoints')
                    if (backupFilter === 'spawnregions') return filename.includes('spawnregions')
                    return true
                  })
                  .map((backup) => {
                    // Determine file type from filename
                    const filename = backup.filename.toLowerCase()
                    let fileType = t('backupsDialog.typeConfig')
                    let typeColor = 'bg-muted-foreground'
                    if (filename.includes('_ini_') || filename.endsWith('.ini')) {
                      fileType = t('backupsDialog.typeIni')
                      typeColor = 'bg-primary'
                    } else if (filename.includes('sandbox')) {
                      fileType = t('backupsDialog.typeSandbox')
                      typeColor = 'bg-chart-4'
                    } else if (filename.includes('spawnpoints')) {
                      fileType = t('backupsDialog.typeSpawnPoints')
                      typeColor = 'bg-accent-foreground'
                    } else if (filename.includes('spawnregions')) {
                      fileType = t('backupsDialog.typeSpawnRegions')
                      typeColor = 'bg-warning'
                    }

                    return (
                      <div key={backup.filename} className="flex flex-col gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-start gap-3 sm:items-center">
                          <Badge className={`${typeColor} text-white text-xs`}>{fileType}</Badge>
                          <div className="min-w-0">
                            <p className="break-all text-sm font-medium font-mono" dir="auto" title={backup.filename}>{backup.filename}</p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(backup.created).toLocaleString(i18n.language)} • {t('backupsDialog.sizeKb', { size: Math.round(backup.size / 1024) })}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 self-end sm:self-auto">
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleRestoreBackup(backup.filename)}
                                >
                                  <Upload className="w-4 h-4 me-1" />
                                  {t('backupsDialog.restore')}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t('backupsDialog.restoreTooltip')}</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                      </div>
                    )
                  })}
                {backups.filter(backup => {
                  if (backupFilter === 'all') return true
                  const filename = backup.filename.toLowerCase()
                  if (backupFilter === 'ini') return filename.includes('_ini_') || filename.endsWith('.ini')
                  if (backupFilter === 'sandbox') return filename.includes('sandbox')
                  if (backupFilter === 'spawnpoints') return filename.includes('spawnpoints')
                  if (backupFilter === 'spawnregions') return filename.includes('spawnregions')
                  return true
                }).length === 0 && backups.length > 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>{t('backupsDialog.noneForFilter', { filter: backupFilter })}</p>
                    <Button variant="link" size="sm" onClick={() => setBackupFilter('all')}>
                      {t('backupsDialog.showAllBackups')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </ScrollArea>

          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {t('backupsDialog.totalCount', { count: backups.length })}
            </p>
            <Button variant="outline" onClick={() => setShowBackups(false)}>
              {t('backupsDialog.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Templates Dialog */}
      <Dialog open={showTemplates} onOpenChange={setShowTemplates}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bookmark className="w-5 h-5" />
              <span className="flex items-center gap-1.5">
                {t('templatesDialog.title')}
                <HelpTip label={t('templatesDialog.title')}>{t('templatesDialog.applyTip')}</HelpTip>
              </span>
            </DialogTitle>
            <DialogDescription>
              {t('templatesDialog.description')}
            </DialogDescription>
          </DialogHeader>

          {/* Save as Template button */}
          <div className="flex items-center justify-between border-b pb-3">
            <span className="text-sm text-muted-foreground">
              {t('templatesDialog.savedCount', { count: templates.length })}
            </span>
            <Button onClick={() => setShowSaveTemplate(true)}>
              <Plus className="w-4 h-4 me-2" />
              {t('templatesDialog.saveCurrentAsTemplate')}
            </Button>
          </div>

          <ScrollArea className="h-[400px]">
            {templates.length === 0 ? (
              <EmptyState type="noData" title={t('templatesDialog.emptyTitle')} description={t('templatesDialog.emptyDesc')} compact />
            ) : (
              <div className="space-y-3">
                {templates.map((template) => (
                  <div key={template.id} className="rounded-lg border p-4 transition-colors hover:bg-muted/50">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="font-medium break-words" dir="auto" title={template.name}>{template.name}</h4>
                          <Badge variant="secondary" className="text-xs">
                            {template.type === 'both' ? t('templatesDialog.typeBoth') : template.type.toUpperCase()}
                          </Badge>
                        </div>
                        {template.description && (
                          <p className="mt-1 break-words text-sm text-muted-foreground" dir="auto" title={template.description}>{template.description}</p>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span>{t('templatesDialog.createdLabel', { date: new Date(template.created).toLocaleDateString(i18n.language) })}</span>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            {template.hasIni && <CheckCircle className="w-3 h-3 text-primary" />}
                            {template.hasIni && t('activeServerStrip.iniLabel')}
                          </span>
                          {template.hasIni && template.hasSandbox && <span>•</span>}
                          <span className="flex items-center gap-1">
                            {template.hasSandbox && <CheckCircle className="w-3 h-3 text-primary" />}
                            {template.hasSandbox && t('activeServerStrip.sandboxLabel')}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 sm:ms-4 sm:self-start">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="default"
                                size="sm"
                                disabled={templateLoading}
                                onClick={() => handleApplyTemplate(template)}
                              >
                                {templateLoading ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <>
                                    <FolderOpen className="w-4 h-4 me-1" />
                                    {t('templatesDialog.apply')}
                                  </>
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('templatesDialog.applyTooltip')}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-11 w-11 text-destructive hover:text-destructive sm:h-9 sm:w-9"
                                onClick={() => handleDeleteTemplate(template.id, template.name)}
                                aria-label={t('templatesDialog.deleteAria', { name: template.name })}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('templatesDialog.deleteTooltip')}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTemplates(false)}>
              {t('templatesDialog.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Save Template Dialog */}
      <Dialog open={showSaveTemplate} onOpenChange={setShowSaveTemplate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Save className="w-5 h-5" />
              {t('saveTemplateDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {t('saveTemplateDialog.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="template-name">{t('saveTemplateDialog.nameLabel')}</Label>
              <Input
                id="template-name"
                placeholder={t('saveTemplateDialog.namePlaceholder')}
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value.slice(0, 60))}
                maxLength={60}
              />
              <p className="text-xs text-muted-foreground">{t('saveTemplateDialog.nameCharCount', { count: newTemplateName.length })}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-desc">{t('saveTemplateDialog.descLabel')}</Label>
              <Textarea
                id="template-desc"
                placeholder={t('saveTemplateDialog.descPlaceholder')}
                value={newTemplateDesc}
                onChange={(e) => setNewTemplateDesc(e.target.value.slice(0, 240))}
                className="min-h-[80px] resize-y"
                maxLength={240}
              />
              <p className="text-xs text-muted-foreground">{t('saveTemplateDialog.descCharCount', { count: newTemplateDesc.length })}</p>
            </div>

            <div className="space-y-3">
              <Label>{t('saveTemplateDialog.includeLabel')}</Label>
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="font-medium">{t('saveTemplateDialog.includeIniTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('saveTemplateDialog.includeIniDesc')}</p>
                </div>
                <Switch
                  checked={saveTemplateIni}
                  onCheckedChange={setSaveTemplateIni}
                  aria-label={t('saveTemplateDialog.includeIniAria')}
                />
              </div>
              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="font-medium">{t('saveTemplateDialog.includeSandboxTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('saveTemplateDialog.includeSandboxDesc')}</p>
                </div>
                <Switch
                  checked={saveTemplateSandbox}
                  onCheckedChange={setSaveTemplateSandbox}
                  aria-label={t('saveTemplateDialog.includeSandboxAria')}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSaveTemplate(false)}>
              {t('saveTemplateDialog.cancel')}
            </Button>
            <Button
              onClick={handleSaveTemplate}
              disabled={templateLoading || !newTemplateName.trim() || (!saveTemplateIni && !saveTemplateSandbox)}
            >
              {templateLoading ? (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 me-2" />
              )}
              {t('saveTemplateDialog.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* File Browser Dialog */}
      <Dialog open={fileBrowserOpen} onOpenChange={setFileBrowserOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="w-5 h-5" />
              {t('fileBrowserDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {t('fileBrowserDialog.description')}
            </DialogDescription>
          </DialogHeader>

          {/* Current path breadcrumb */}
          <div className="flex items-center gap-1.5 text-xs font-mono bg-muted/50 rounded-md px-3 py-2 overflow-x-auto">
            <span className="text-muted-foreground truncate" title={fileBrowserPath}>{fileBrowserPath || t('fileBrowserDialog.loadingPath')}</span>
          </div>

          {/* File listing */}
          <ScrollArea className="flex-1 min-h-[300px] max-h-[400px] border rounded-md">
            {fileBrowserLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="p-2 space-y-0.5">
                {/* Parent directory */}
                {fileBrowserParent && (
                  <button
                    onClick={() => browseTo(fileBrowserParent!)}
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-md hover:bg-muted/70 text-sm transition-colors"
                  >
                    <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
                    <span className="text-muted-foreground">..</span>
                  </button>
                )}

                {/* Directories */}
                {fileBrowserDirs.map(dir => (
                  <button
                    key={`d-${dir}`}
                    onClick={() => browseTo(fileBrowserPath + (fileBrowserPath.endsWith('/') || fileBrowserPath.endsWith('\\') ? '' : (fileBrowserPath.includes('/') ? '/' : '\\')) + dir)}
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-md hover:bg-muted/70 text-sm transition-colors"
                  >
                    <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
                    <span className="truncate">{dir}</span>
                  </button>
                ))}

                {/* Files */}
                {fileBrowserFiles.map(file => {
                  const fullPath = fileBrowserPath + (fileBrowserPath.endsWith('/') || fileBrowserPath.endsWith('\\') ? '' : (fileBrowserPath.includes('/') ? '/' : '\\')) + file.name
                  const isSelected = fileBrowserSelected === fullPath
                  return (
                    <button
                      key={`f-${file.name}`}
                      onClick={() => setFileBrowserSelected(fullPath)}
                      onDoubleClick={() => {
                        setFileBrowserSelected(fullPath)
                        setIniSettings(prev => ({ ...prev, [fileBrowserKey]: fullPath }))
                        setFileBrowserOpen(false)
                      }}
                      className={`flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm transition-colors ${
                        isSelected ? 'bg-primary/15 border border-primary/30 ring-1 ring-primary/20' : 'hover:bg-muted/70'
                      }`}
                    >
                      <FileText className="w-4 h-4 text-primary shrink-0" />
                      <span className="truncate flex-1 text-start">{file.name}</span>
                      <span className="text-xs text-muted-foreground shrink-0">{file.ext}</span>
                    </button>
                  )
                })}

                {/* Empty state */}
                {fileBrowserDirs.length === 0 && fileBrowserFiles.length === 0 && !fileBrowserParent && (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    {t('fileBrowserDialog.emptyNoParent')}
                  </div>
                )}
                {fileBrowserDirs.length === 0 && fileBrowserFiles.length === 0 && fileBrowserParent && (
                  <div className="text-center py-4 text-sm text-muted-foreground">
                    {t('fileBrowserDialog.emptyWithParent')}
                  </div>
                )}
              </div>
            )}
          </ScrollArea>

          {/* Preview + selection info */}
          {fileBrowserSelected && (
            <div className="flex items-start gap-3 bg-muted/30 rounded-md p-3 border">
              <div className="rounded-md border bg-background p-1 shrink-0">
                <AuthImage
                  filePath={fileBrowserSelected}
                  alt="Preview"
                  className="max-h-[64px] max-w-[120px] object-contain rounded"
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{fileBrowserSelected.split(/[/\\]/).pop()}</p>
                <p className="text-xs text-muted-foreground font-mono truncate mt-0.5" title={fileBrowserSelected}>{fileBrowserSelected}</p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setFileBrowserOpen(false)}>
              {t('fileBrowserDialog.cancel')}
            </Button>
            <Button onClick={confirmFileBrowserSelection} disabled={!fileBrowserSelected}>
              <Check className="w-4 h-4 me-2" />
              {t('fileBrowserDialog.selectFile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
