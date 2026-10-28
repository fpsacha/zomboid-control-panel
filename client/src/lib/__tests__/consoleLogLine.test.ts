import { describe, expect, it } from 'vitest'
import { formatLogTime, isConsoleNoiseLine, parseLogLine, type ParsedLogLine } from '../consoleLogLine'

// SECURITY (2026-10-28): the Console page's Server Log shows the game's
// server-console.txt, and a Workshop mod's Lua print() writes whatever text
// it likes there. The pattern that read each line backtracked (cubic on a
// "LOG : <word> t:1 t:1 ..." line with no ">"), as did the SpriteConfig
// noise pattern, so one crafted line froze the tab of every admin and
// moderator who opened the page. Each hostile shape below took seconds
// with those patterns; the readers that replaced them must take well under
// a second and read every line as the old patterns did (checked at the end).

const LIMIT_MS = 1000
const LS = String.fromCharCode(0x2028)

function timed(fn: () => unknown): number {
  const started = performance.now()
  fn()
  return performance.now() - started
}

describe('the Server Log reads hostile console lines quickly', () => {
  it('a "LOG : <word>" line full of t: fields and no ">"', () => {
    const line = 'LOG : ' + 'a'.repeat(2500) + ' t:1'.repeat(625)
    expect(timed(() => parseLogLine(line))).toBeLessThan(LIMIT_MS)
    expect(parseLogLine(line)).toMatchObject({ type: 'LOG', category: '' })
  })

  it('a long "LOG : <word>" line with no ">"', () => {
    const line = 'LOG : ' + 'a'.repeat(50_000)
    expect(timed(() => parseLogLine(line))).toBeLessThan(LIMIT_MS)
  })

  it('the noise filter on a line repeating SpriteConfig.initObjectInfo', () => {
    const line = 'SpriteConfig.initObjectInfo'.repeat(15_000)
    expect(timed(() => isConsoleNoiseLine(line))).toBeLessThan(LIMIT_MS)
    expect(isConsoleNoiseLine(line)).toBe(false)
  })

  // Adversary: other shapes, with no length cut anywhere in front of them.
  it('every reader on 1 MB lines', () => {
    const MB = 1_000_000
    const cases = [
      () => parseLogLine('LOG : ' + 'a'.repeat(MB)),
      () => parseLogLine('LOG : ' + 'a'.repeat(MB / 2) + ' t:1'.repeat(MB / 8)),
      () => parseLogLine('LOG : ' + 'a'.repeat(MB / 2) + ' t:1'.repeat(MB / 8) + '>\rx'),
      () => parseLogLine('LOG : a t:' + '1'.repeat(MB) + ' > x'),
      () => parseLogLine('LOG : General > at ' + ' '.repeat(MB) + 'x'),
      () => parseLogLine('LOG : General > ' + 'a'.repeat(MB) + ' '),
      () => parseLogLine('LOG' + ' '.repeat(MB) + 'x'),
      () => parseLogLine('... ' + ' '.repeat(MB) + '1'.repeat(MB)),
      () => isConsoleNoiseLine(('SpriteConfig.initObjectInfo' + LS).repeat(MB / 28)),
      () => isConsoleNoiseLine('SpriteConfig.initObjectInfo '.repeat(MB / 28) + 'Invalid SpriteConfig'),
    ]
    for (const run of cases) expect(timed(run)).toBeLessThan(LIMIT_MS)
  })
})

describe('the Server Log reads ordinary lines as before', () => {
  it('reads the game\'s own lines', () => {
    const t = 1774895897563
    expect(parseLogLine(`LOG  : General      f:0, t:${t}, st:0> SERVER STARTED`)).toEqual({
      type: 'LOG', category: 'General', message: 'SERVER STARTED', raw: `LOG  : General      f:0, t:${t}, st:0> SERVER STARTED`, time: formatLogTime(t),
    })
    expect(parseLogLine(`LOG  : General      f:0, t:${t}, st:0> java.lang.NullPointerException: x`).type).toBe('ERROR')
    expect(parseLogLine('WARN : Network> slow').type).toBe('WARN')
    expect(parseLogLine('\tat zombie.network.GameServer.main(GameServer.java:1)').type).toBe('ERROR')
    expect(isConsoleNoiseLine('LOG  : General> SpriteConfig.initObjectInfo> Invalid SpriteConfig for x')).toBe(true)
    expect(isConsoleNoiseLine('LOG  : General> moveZombie: There are no zombies')).toBe(true)
    expect(isConsoleNoiseLine('LOG  : General> player joined')).toBe(false)
  })
})

// ─── The readers give what the patterns they replaced gave ───────────────

function oldParseLogLine(line: string): ParsedLogLine {
  const trimmed = line.trim()
  if (!trimmed) return { type: 'UNKNOWN', category: '', message: '', raw: line }
  const match = trimmed.match(/^(LOG|WARN|ERROR|DEBUG|INFO)\s*:\s*(\w+)(?:[^>]*?\bt:(\d+))?[^>]*>\s*(.+)$/i)
  if (match) {
    let type = match[1].toUpperCase() as ParsedLogLine['type']
    const tField = match[3]
    const message = match[4]
    if (type === 'LOG' && /^(java\.|kotlin\.|zombie\.|com\.|org\.|at\s+\S+\.|Exception in thread|Caused by:|\S+(Exception|Error)(:|\s|$))/i.test(message)) {
      type = 'ERROR'
    }
    return { type, category: match[2], message, raw: line, time: tField ? formatLogTime(Number(tField)) : undefined }
  }
  if (trimmed.startsWith('ERROR')) return { type: 'ERROR', category: '', message: trimmed.replace(/^ERROR\s*:?\s*/i, ''), raw: line }
  if (trimmed.startsWith('WARN')) return { type: 'WARN', category: '', message: trimmed.replace(/^WARN\s*:?\s*/i, ''), raw: line }
  if (trimmed.startsWith('LOG')) return { type: 'LOG', category: '', message: trimmed.replace(/^LOG\s*:?\s*/i, ''), raw: line }
  if (/^(\s*at\s+\S+|Caused by:|\.{3}\s+\d+ more|Exception in thread)/.test(trimmed)) {
    return { type: 'ERROR', category: '', message: trimmed, raw: line }
  }
  return { type: 'UNKNOWN', category: '', message: trimmed, raw: line }
}

const OLD_NOISE = [
  /moveZombie: There are no zombies/i,
  /ItemPickInfo -> cannot get ID for container/i,
  /IsoThumpable not found on square/i,
  /SpriteConfig\.initObjectInfo.*Invalid SpriteConfig/i,
  /MOWoodenWalFrame\.lua: replacing isoObject/i,
  /OreVein\{startPoint/i,
  /SkeletonBone not resolved for bone/i,
  /action was null, object: null/i,
  /Could not find item type for/i,
  /Canceled loading wrong transition/i,
]

// A small seeded generator, so a failure always repeats.
function generator(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)]
  const build = (tokens: readonly string[], max: number) => {
    let s = ''
    const n = 1 + Math.floor(next() * max)
    for (let i = 0; i < n; i++) s += pick(tokens)
    return s
  }
  return { next, pick, build }
}

describe('the readers match the old patterns', () => {
  it('parseLogLine()', () => {
    const g = generator(5)
    const starts = ['LOG', 'WARN', 'ERROR', 'DEBUG', 'INFO', 'log', 'Error', ' LOG', 'LOGX', '']
    const tokens = [' : ', ':', ' ', '  ', '\t', 'General', 'Lua', 'a', '_', '1', 't:1774895897563', ' t:1774895897563', 't:12', ' T:1774895897563',
      'f:0, ', 'st:0', '>', '> ', ' > ', 'java.lang.NullPointerException', 'at zombie.x.y(Z.java:1)', 'at ', 'Caused by: x', 'msg', 'FooError',
      'Exception in thread', '... 3 more', '...', '\r', LS, '\n']
    const part = () => g.build(tokens, 3)
    for (let i = 0; i < 8000; i++) {
      const line = g.next() < 0.4
        ? g.pick(starts) + g.build(tokens, 9)
        : g.pick(starts) + g.pick([' : ', ':', '  : ', ' :\t']) + g.pick(['General', 'Lua', 'a1_', 't', ''])
          + (g.next() < 0.6 ? part() : '') + g.pick(['>', '> ', ' > ', '  f:0, t:1774895897563, st:0> ']) + (g.next() < 0.8 ? part() : '')
      expect(parseLogLine(line), JSON.stringify(line)).toEqual(oldParseLogLine(line))
    }
  })

  it('isConsoleNoiseLine()', () => {
    const g = generator(17)
    const tokens = ['SpriteConfig.initObjectInfo', 'Invalid SpriteConfig', 'spriteconfig.INITOBJECTINFO', 'invalid spriteconfig', ' x ', 'SpriteConfig',
      'moveZombie: There are no zombies', 'OreVein{startPoint', 'Could not find item type', '\r', LS, '\n', ' ']
    for (let i = 0; i < 8000; i++) {
      const line = g.build(tokens, 6)
      expect(isConsoleNoiseLine(line), JSON.stringify(line)).toBe(OLD_NOISE.some((p) => p.test(line)))
    }
  })
})
