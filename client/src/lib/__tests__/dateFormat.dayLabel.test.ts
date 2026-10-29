import { describe, expect, it } from 'vitest'
import { formatDayLabel, localDayKey } from '../dateFormat'

const now = new Date(2026, 9, 29, 11, 40)

describe('day labels for activity lists', () => {
  it('names today and yesterday, and dates anything older', () => {
    expect(formatDayLabel(new Date(2026, 9, 29, 0, 5), { language: 'en', now })).toBe('Today')
    expect(formatDayLabel(new Date(2026, 9, 28, 13, 52), { language: 'en', now })).toBe('Yesterday')
    const older = formatDayLabel(new Date(2026, 9, 26, 10, 41), { language: 'en', now })
    expect(older).not.toMatch(/today|yesterday/i)
    expect(older).toMatch(/26/)
  })

  it('uses the UI language for the relative words', () => {
    expect(formatDayLabel(new Date(2026, 9, 28, 9, 0), { language: 'fr', now })).toBe('Hier')
  })

  it('groups by the local calendar day and ignores invalid values', () => {
    expect(localDayKey(new Date(2026, 9, 28, 23, 59))).toBe('2026-10-28')
    expect(localDayKey(new Date(2026, 9, 29, 0, 0))).toBe('2026-10-29')
    expect(localDayKey('not a date')).toBe('')
    expect(formatDayLabel(undefined)).toBe('')
  })
})
