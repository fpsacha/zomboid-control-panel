// The Console page's Server Log tab: one line of the game's
// server-console.txt read into its type, category, time and message, and
// the routine lines its noise filter hides.
//
// SECURITY (2026-10-28): a Workshop mod's Lua print() writes text of its
// choosing into that log, and every line the tab shows is read here (again
// each time new lines shift the list). The pattern that read a line had
// three unbounded runs before its ">" and backtracked, and the SpriteConfig
// noise pattern rescanned the line once per mention: one crafted line froze
// the tab of every admin and moderator who opened the Console page. A line
// is now read by position (indexOf) and with patterns that cannot backtrack,
// giving what the old pattern gave (consoleLogLine.test.ts checks it).

export interface ParsedLogLine {
  type: 'LOG' | 'WARN' | 'ERROR' | 'DEBUG' | 'INFO' | 'UNKNOWN'
  category: string
  message: string
  raw: string
  /** Human-readable HH:mm:ss extracted from PZ's `t:<epoch_ms>` field, if present. */
  time?: string
}

// Convert a PZ epoch-ms timestamp to local HH:mm:ss. PZ logs `t:1777482455659`
// where the value is milliseconds since epoch. We render it as wall-clock time
// in the viewer's locale so admins can correlate events without doing math.
export function formatLogTime(epochMs: number): string | undefined {
  if (!Number.isFinite(epochMs) || epochMs < 1_000_000_000_000) return undefined
  try {
    const d = new Date(epochMs)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  } catch { return undefined }
}

// "LOG : Category" at the start of a line; the category is a whole word.
const HEAD_RE = /^(LOG|WARN|ERROR|DEBUG|INFO)\s*:\s*(\w+)/i
// The first `t:<epoch_ms>` between the category and the ">".
const TIME_FIELD_RE = /\bt:(\d+)/i
// What `.` does not match: a message may not hold one, and the SpriteConfig
// noise pair may not have one between its two parts.
const LINE_BREAK_RE = /[\n\r\u2028\u2029]/
// PZ logs every exception as `LOG : General ... > java.lang.NullPointerException ...`.
const JAVA_EXCEPTION_RE = /^(java\.|kotlin\.|zombie\.|com\.|org\.|at\s+\S+\.|Exception in thread|Caused by:|\S+(Exception|Error)(:|\s|$))/i

export function parseLogLine(line: string): ParsedLogLine {
  // PZ log format: "TYPE : Category    f:XXXXX, t:XXXXX, st:XXXXX> Source > Message"
  // or just plain text
  const trimmed = line.trim()
  if (!trimmed) {
    return { type: 'UNKNOWN', category: '', message: '', raw: line }
  }

  // LOG/WARN/ERROR : Category  f:xxx, t:<epoch_ms>, st:xxx> Message
  // The message is everything after the first ">", less its leading spaces.
  const head = HEAD_RE.exec(trimmed)
  if (head) {
    const gt = trimmed.indexOf('>', head[0].length)
    const message = gt === -1 ? '' : trimmed.slice(gt + 1).trimStart()
    if (message && !LINE_BREAK_RE.test(message)) {
      let type = head[1].toUpperCase() as ParsedLogLine['type']
      const tField = TIME_FIELD_RE.exec(trimmed.slice(head[0].length, gt))?.[1]
      // Promote LOG → ERROR when the message body is a Java exception or stack
      // trace, which would otherwise be invisible against routine LOG spam.
      if (type === 'LOG' && JAVA_EXCEPTION_RE.test(message)) {
        type = 'ERROR'
      }
      return {
        type,
        category: head[2],
        message,
        raw: line,
        time: tField ? formatLogTime(Number(tField)) : undefined,
      }
    }
  }

  // Check for simple prefixes
  if (trimmed.startsWith('ERROR')) {
    return { type: 'ERROR', category: '', message: trimmed.replace(/^ERROR\s*:?\s*/i, ''), raw: line }
  }
  if (trimmed.startsWith('WARN')) {
    return { type: 'WARN', category: '', message: trimmed.replace(/^WARN\s*:?\s*/i, ''), raw: line }
  }
  if (trimmed.startsWith('LOG')) {
    return { type: 'LOG', category: '', message: trimmed.replace(/^LOG\s*:?\s*/i, ''), raw: line }
  }
  // Bare Java stack-trace continuation lines ("\tat zombie.network...", "Caused by: ...")
  if (/^(\s*at\s+\S+|Caused by:|\.{3}\s+\d+ more|Exception in thread)/.test(trimmed)) {
    return { type: 'ERROR', category: '', message: trimmed, raw: line }
  }

  return { type: 'UNKNOWN', category: '', message: trimmed, raw: line }
}

// Routine, repetitive game lines the Server Log hides while its filter is on.
const NOISE_PATTERNS = [
  /moveZombie: There are no zombies/i,
  /ItemPickInfo -> cannot get ID for container/i,
  /IsoThumpable not found on square/i,
  /MOWoodenWalFrame\.lua: replacing isoObject/i,
  /OreVein\{startPoint/i,
  /SkeletonBone not resolved for bone/i,
  /action was null, object: null/i,
  /Could not find item type for/i,
  /Canceled loading wrong transition/i,
]
const SPRITE_INIT_RE = /SpriteConfig\.initObjectInfo/i
const SPRITE_INVALID_RE = /Invalid SpriteConfig/i
const SPRITE_INIT_LENGTH = 'SpriteConfig.initObjectInfo'.length

export function isConsoleNoiseLine(line: string): boolean {
  if (NOISE_PATTERNS.some((pattern) => pattern.test(line))) return true
  // "SpriteConfig.initObjectInfo ... Invalid SpriteConfig", with no line
  // break between them: the first mention, then the second after it.
  return line.split(LINE_BREAK_RE).some((part) => {
    const at = part.search(SPRITE_INIT_RE)
    return at !== -1 && SPRITE_INVALID_RE.test(part.slice(at + SPRITE_INIT_LENGTH))
  })
}
