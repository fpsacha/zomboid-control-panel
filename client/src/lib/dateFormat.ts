import { useMemo, useSyncExternalStore } from 'react'
import i18n from '@/i18n'

// Every date the panel shows goes through here, so one choice in
// Settings > General > Appearance applies everywhere and a date never shows
// two ways. The UI language codes carry no region ('en', not 'en-GB'), so
// formatting with the language alone gave every English-UI user the US
// order: Automatic now adds the browser's region, and the explicit orders
// cover everyone else. Per browser, like the theme and the language.

export type DateFormatPref = 'auto' | 'dmy' | 'mdy' | 'ymd'

export const DATE_FORMAT_PREFS: readonly DateFormatPref[] = ['auto', 'dmy', 'mdy', 'ymd']

export const DATE_FORMAT_STORAGE_KEY = 'zcp-date-format'

type DateInput = string | number | Date | null | undefined

interface BaseOptions {
  /** UI language to format for; defaults to the current one. */
  language?: string
  timeZone?: string
}

export interface DateOptions extends BaseOptions {
  /** Defaults to the saved preference. */
  pref?: DateFormatPref
  /** 'medium' spells the month out under Automatic; the explicit orders are always numeric. */
  style?: 'short' | 'medium'
}

export interface DateTimeOptions extends DateOptions {
  seconds?: boolean
  timeZoneName?: 'short' | 'long'
}

export interface TimeOptions extends BaseOptions {
  seconds?: boolean
  timeZoneName?: 'short' | 'long'
  /** A two-digit hour ('09:07'), for fixed-width columns. */
  pad?: boolean
}

function isDateFormatPref(value: unknown): value is DateFormatPref {
  return typeof value === 'string' && (DATE_FORMAT_PREFS as readonly string[]).includes(value)
}

// A choice this browser refused to save (storage blocked, or full while
// reads still work): it wins over storage until reload.
let unsavedPref: DateFormatPref | null = null
const listeners = new Set<() => void>()

export function getDateFormatPref(): DateFormatPref {
  if (unsavedPref) return unsavedPref
  try {
    const stored = localStorage.getItem(DATE_FORMAT_STORAGE_KEY)
    return isDateFormatPref(stored) ? stored : 'auto'
  } catch {
    return 'auto'
  }
}

export function setDateFormatPref(pref: DateFormatPref): void {
  try {
    localStorage.setItem(DATE_FORMAT_STORAGE_KEY, pref)
    unsavedPref = null
  } catch {
    unsavedPref = pref
  }
  for (const listener of [...listeners]) listener()
}

function browserRegion(): string | undefined {
  try {
    const first = Array.isArray(navigator.languages) && navigator.languages.length > 0 ? navigator.languages[0] : navigator.language
    return first ? new Intl.Locale(first.replace(/_/g, '-')).region : undefined
  } catch {
    return undefined
  }
}

const localeCache = new Map<string, string>()

/**
 * The locale Automatic formats in: the UI language plus the region of the
 * browser's first preferred language (English UI + en-GB browser → en-GB,
 * day/month/year; + en-US → unchanged). UI codes that already name a region
 * (zh-CN, zh-TW, pt-BR) keep it. The region brings the order and the hour
 * cycle, but the digits stay those of the panel's numbers, which use the UI
 * language alone: ar-EG on its own would print an Arabic UI's dates in
 * Arabic-Indic digits beside Latin counts and sizes.
 */
export function getFormattingLocale(uiLanguage: string = i18n.language || 'en'): string {
  const region = browserRegion()
  const key = `${uiLanguage}|${region ?? ''}`
  let locale = localeCache.get(key)
  if (locale === undefined) {
    locale = uiLanguage
    try {
      if (region && !new Intl.Locale(uiLanguage).region) {
        locale = new Intl.Locale(uiLanguage, { region }).toString()
        const digits = new Intl.NumberFormat(uiLanguage).resolvedOptions().numberingSystem
        if (new Intl.DateTimeFormat(locale).resolvedOptions().numberingSystem !== digits) {
          locale = new Intl.Locale(uiLanguage, { region, numberingSystem: digits }).toString()
        }
      }
    } catch {
      // not a well-formed tag: Intl falls back on its own
    }
    localeCache.set(key, locale)
  }
  return locale
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function buildFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options)
  } catch {
    // an unknown locale, or a time zone this browser lacks
  }
  try {
    return new Intl.DateTimeFormat('en', options)
  } catch {
    // the zone is the problem: show the browser's own time, unlabelled
  }
  const { timeZone: _zone, timeZoneName: _label, ...rest } = options
  try {
    return new Intl.DateTimeFormat(locale, rest)
  } catch {
    return new Intl.DateTimeFormat('en', rest)
  }
}

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let cached = formatterCache.get(key)
  if (!cached) {
    cached = buildFormatter(locale, options)
    formatterCache.set(key, cached)
  }
  return cached
}

export interface ZonedDateParts {
  year: number
  /** 1-12 */
  month: number
  day: number
  hour: number
  minute: number
  /** 0 = Sunday, as in cron */
  weekday: number
}

const zonedPartsCache = new Map<string, Intl.DateTimeFormat | null>()
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/**
 * The wall-clock fields of an instant in an IANA zone (the scheduler's own
 * zone, which can differ from the browser's). Formats nothing for display:
 * the numbers feed schedule maths. null for a zone this browser doesn't know.
 */
export function zonedDateParts(value: Date | number, timeZone: string): ZonedDateParts | null {
  let parts = zonedPartsCache.get(timeZone)
  if (parts === undefined) {
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
        hourCycle: 'h23',
      })
    } catch {
      parts = null
    }
    zonedPartsCache.set(timeZone, parts)
  }
  if (!parts) return null
  const fields: Record<string, string> = {}
  for (const part of parts.formatToParts(value)) fields[part.type] = part.value
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour) % 24,
    minute: Number(fields.minute),
    weekday: WEEKDAY_INDEX[fields.weekday] ?? 0,
  }
}

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

// Arabic puts a right-to-left mark before each separator so the date reads
// in the right order inside RTL text.
const RLM = String.fromCharCode(0x200f)

// The explicit orders: the parts come from the formatting locale, so the
// digits match the time printed next to them.
function orderedDate(date: Date, locale: string, pref: Exclude<DateFormatPref, 'auto'>, timeZone?: string): string {
  const parts = formatter(locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  const day = part('day')
  const month = part('month')
  const year = part('year')
  const mark = parts.some((p) => p.type === 'literal' && p.value.includes(RLM)) ? RLM : ''
  if (pref === 'dmy') return `${day}${mark}/${month}${mark}/${year}`
  if (pref === 'mdy') return `${month}${mark}/${day}${mark}/${year}`
  return `${year}${mark}-${month}${mark}-${day}`
}

const twoDigitHourCache = new Map<string, boolean>()

// Whether a locale writes a morning hour with two digits on its own ('08:00'
// in de, fr, uk, pt-BR, zh-CN, en-GB; '8:00' in es, zh-TW, ar, en-US). Asking
// for hour: 'numeric' in those gives '8:00' beside '20:00', so the hour is
// only left at 'numeric' for the locales whose own style is unpadded.
function localePadsHour(locale: string): boolean {
  let pads = twoDigitHourCache.get(locale)
  if (pads === undefined) {
    try {
      const hour = new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: 'UTC' })
        .formatToParts(new Date(Date.UTC(2026, 0, 1, 8, 5)))
        .find((p) => p.type === 'hour')?.value
      pads = hour?.length === 2
    } catch {
      pads = false
    }
    twoDigitHourCache.set(locale, pads)
  }
  return pads
}

function timeOptions(options: TimeOptions, locale: string): Intl.DateTimeFormatOptions {
  return {
    hour: options.pad || localePadsHour(locale) ? '2-digit' : 'numeric',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
    timeZone: options.timeZone,
    ...(options.timeZoneName ? { timeZoneName: options.timeZoneName } : {}),
  }
}

function formatDateIn(locale: string, pref: DateFormatPref, value: DateInput, options: DateOptions): string {
  const date = toDate(value)
  if (!date) return ''
  if (pref !== 'auto') return orderedDate(date, locale, pref, options.timeZone)
  const style: Intl.DateTimeFormatOptions = options.style === 'medium'
    ? { dateStyle: 'medium' }
    : { year: 'numeric', month: 'numeric', day: 'numeric' }
  return formatter(locale, { ...style, timeZone: options.timeZone }).format(date)
}

function formatDateTimeIn(locale: string, pref: DateFormatPref, value: DateInput, options: DateTimeOptions): string {
  const date = toDate(value)
  if (!date) return ''
  if (pref !== 'auto') {
    return `${orderedDate(date, locale, pref, options.timeZone)} ${formatter(locale, timeOptions(options, locale)).format(date)}`
  }
  // Intl refuses timeZoneName next to dateStyle/timeStyle, so a labelled
  // medium date is spelled out field by field.
  if (options.style === 'medium' && !options.timeZoneName) {
    return formatter(locale, {
      dateStyle: 'medium',
      timeStyle: options.seconds ? 'medium' : 'short',
      timeZone: options.timeZone,
    }).format(date)
  }
  const dateFields: Intl.DateTimeFormatOptions = options.style === 'medium'
    ? { year: 'numeric', month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'numeric', day: 'numeric' }
  return formatter(locale, { ...dateFields, ...timeOptions(options, locale) }).format(date)
}

function formatTimeIn(locale: string, value: DateInput, options: TimeOptions): string {
  const date = toDate(value)
  if (!date) return ''
  return formatter(locale, timeOptions(options, locale)).format(date)
}

/** A date without the time, in the saved order; '' for a missing or invalid value. */
export function formatDate(value: DateInput, options: DateOptions = {}): string {
  return formatDateIn(getFormattingLocale(options.language), options.pref ?? getDateFormatPref(), value, options)
}

/** A date and time, in the saved order; '' for a missing or invalid value. */
export function formatDateTime(value: DateInput, options: DateTimeOptions = {}): string {
  return formatDateTimeIn(getFormattingLocale(options.language), options.pref ?? getDateFormatPref(), value, options)
}

/**
 * The local calendar day of a value as YYYY-MM-DD, to group events by day;
 * '' for a missing or invalid value.
 */
export function localDayKey(value: DateInput): string {
  const date = toDate(value)
  if (!date) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * A day heading: "Today" / "Yesterday" in the UI language, otherwise the
 * date in the saved order. '' for a missing or invalid value.
 */
export function formatDayLabel(value: DateInput, options: DateOptions & { now?: Date } = {}): string {
  const date = toDate(value)
  if (!date) return ''
  const now = options.now ?? new Date()
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(date) - startOf(now)) / 86_400_000)
  if (days === 0 || days === -1) {
    const word = new Intl.RelativeTimeFormat(getFormattingLocale(options.language), { numeric: 'auto' }).format(days, 'day')
    return word.charAt(0).toLocaleUpperCase() + word.slice(1)
  }
  return formatDate(date, options)
}

/** A time of day in the formatting locale; '' for a missing or invalid value. */
export function formatTime(value: DateInput, options: TimeOptions = {}): string {
  return formatTimeIn(getFormattingLocale(options.language), value, options)
}

export interface DateFormatter {
  pref: DateFormatPref
  locale: string
  formatDate: (value: DateInput, options?: DateOptions) => string
  formatDateTime: (value: DateInput, options?: DateTimeOptions) => string
  formatTime: (value: DateInput, options?: TimeOptions) => string
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another tab changing the choice, the browser's languages changing, and
  // the UI language switching all change what a date looks like.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === DATE_FORMAT_STORAGE_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener('languagechange', listener)
  i18n.on('languageChanged', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('languagechange', listener)
    i18n.off('languageChanged', listener)
  }
}

function snapshot(): string {
  return `${getDateFormatPref()}|${getFormattingLocale()}`
}

/**
 * The formatters bound to the saved preference and the current language.
 * The component re-renders when either changes, so dates on screen follow
 * the Settings select at once.
 */
export function useDateFormat(): DateFormatter {
  const key = useSyncExternalStore(subscribe, snapshot, snapshot)
  return useMemo(() => {
    const [pref, locale] = key.split('|') as [DateFormatPref, string]
    return {
      pref,
      locale,
      formatDate: (value, options = {}) => formatDateIn(options.language ? getFormattingLocale(options.language) : locale, options.pref ?? pref, value, options),
      formatDateTime: (value, options = {}) => formatDateTimeIn(options.language ? getFormattingLocale(options.language) : locale, options.pref ?? pref, value, options),
      formatTime: (value, options = {}) => formatTimeIn(options.language ? getFormattingLocale(options.language) : locale, value, options),
    }
  }, [key])
}
