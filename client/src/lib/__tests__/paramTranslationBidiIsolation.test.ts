import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { resolveRegisteredTranslation } from '../paramTranslation'

// bug-hunt-2026-09-08 (Arabic render pass): confirmed against a real disk
// (952.8 GB total, 196.2 GB free, server-side params verified correct) that
// a registered message like "{{free}} free of {{total}}." renders with the
// two values effectively scrambled in Arabic RTL. resolveRegisteredTranslation
// now wraps every non-`count` param in U+2066/U+2069 bidi-isolate marks when
// the active language is RTL. jsdom does not implement Unicode bidi visual
// reordering (see the DashboardPerformanceCharts fix's own test file for the
// same limitation) -- what IS verifiable here, and is the actual contract,
// is that the isolate marks are present around each value in RTL, absent in
// LTR (so every existing exact-string test elsewhere stays byte-identical),
// and that `count` is never wrapped (it must reach i18next as a real number
// to drive CLDR plural-category selection).
const ISOLATE_START = '⁦'
const ISOLATE_END = '⁩'

describe('resolveRegisteredTranslation -- bidi isolation on interpolated params', () => {
  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('wraps non-count params in isolate marks when the active language is RTL', async () => {
    await i18n.changeLanguage('ar')
    const result = resolveRegisteredTranslation('debug', 'diagnostics.checks.disk.free.ok.message', {
      free: '196.2 GB',
      total: '952.8 GB',
    })
    expect(result).not.toBeNull()
    expect(result).toContain(`${ISOLATE_START}196.2 GB${ISOLATE_END}`)
    expect(result).toContain(`${ISOLATE_START}952.8 GB${ISOLATE_END}`)
  })

  it('does not add isolate marks when the active language is LTR (English)', async () => {
    await i18n.changeLanguage('en')
    const result = resolveRegisteredTranslation('debug', 'diagnostics.checks.disk.free.ok.message', {
      free: '196.2 GB',
      total: '952.8 GB',
    })
    expect(result).not.toBeNull()
    expect(result).not.toContain(ISOLATE_START)
    expect(result).not.toContain(ISOLATE_END)
    expect(result).toBe('196.2 GB free of 952.8 GB.')
  })

  it('never wraps `count`, even when isolating everything else in RTL', async () => {
    await i18n.changeLanguage('ar')
    // No current caller of resolveRegisteredTranslation passes a bare
    // pluralisable base key (the function resolves ONE literal template via
    // i18n.getResource, which returns an object -- not a string -- for an
    // unsuffixed plural base like "andMore", so it can't run pluralisation
    // itself today). This still exercises the real risk directly: a
    // `count` param reaching this function, on an exact key that uses
    // {{count}} for on-screen interpolation, must never be isolate-wrapped
    // -- defensive-in-depth against the day a registered key DOES branch on
    // count, given this session's own earlier plural-parity work made that
    // exact regression class concrete.
    const result = resolveRegisteredTranslation('dashboardVerdict', 'andMore_one', { count: 1 })
    expect(result).not.toBeNull()
    expect(result).not.toContain(ISOLATE_START)
    expect(result).not.toContain(ISOLATE_END)
    expect(result).toContain('1')
  })
})
