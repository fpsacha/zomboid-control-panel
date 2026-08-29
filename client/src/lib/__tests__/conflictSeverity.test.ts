import { describe, expect, it } from 'vitest'
import type { ConflictPair } from '@/types'
import { createConflictScanSnapshot, getConflictPairSeverity, matchesConflictPairSeverity, recalculateConflictWinners, summarizeConflictPairSeverities } from '../conflictSeverity'

function pair(highCount: number, mediumCount: number, lowCount: number): ConflictPair {
  return {
    modA: { workshopId: '1', modId: 'A', modName: 'A' },
    modB: { workshopId: '2', modId: 'B', modName: 'B' },
    files: [],
    highCount,
    mediumCount,
    lowCount,
  }
}

describe('conflict pair severity', () => {
  it('normalizes Workshop order but preserves Mods= load order in scan snapshots', () => {
    expect(createConflictScanSnapshot(['2', '1'], ['B', 'A'])).toBe(createConflictScanSnapshot(['1', '2'], ['B', 'A']))
    expect(createConflictScanSnapshot(['1', '2'], ['B', 'A'])).not.toBe(createConflictScanSnapshot(['1', '2'], ['A', 'B']))
  })

  it('classifies a pair by its highest file severity', () => {
    expect(getConflictPairSeverity(pair(1, 2, 3))).toBe('high')
    expect(getConflictPairSeverity(pair(0, 2, 3))).toBe('medium')
    expect(getConflictPairSeverity(pair(0, 0, 3))).toBe('low')
  })

  it('keeps Critical, Medium, and Low totals mutually exclusive', () => {
    expect(summarizeConflictPairSeverities([
      pair(1, 2, 3),
      pair(0, 2, 3),
      pair(0, 0, 3),
    ])).toEqual({ all: 3, real: 2, high: 1, medium: 1, low: 1 })
  })

  it('uses the same exclusive severity rule for filters', () => {
    const mixed = pair(1, 2, 3)
    expect(matchesConflictPairSeverity(mixed, 'high')).toBe(true)
    expect(matchesConflictPairSeverity(mixed, 'medium')).toBe(false)
    expect(matchesConflictPairSeverity(mixed, 'low')).toBe(false)
    expect(matchesConflictPairSeverity(mixed, 'real')).toBe(true)
  })

  it('recalculates winners across every mod that ships the same file', () => {
    const modA = { workshopId: '1', modId: 'A', modName: 'A' }
    const modB = { workshopId: '2', modId: 'B', modName: 'B' }
    const modC = { workshopId: '3', modId: 'C', modName: 'C' }
    const file = { file: 'lua/shared/test.lua', category: 'lua-shared', severity: 'high' as const, winner: modC }
    const result = {
      totalConflicts: 1,
      identicalSkipped: 0,
      pairs: [
        { ...pair(1, 0, 0), modA, modB, files: [file], thirdPartyWins: 1 },
        { ...pair(1, 0, 0), modA, modB: modC, files: [file], bWins: 1 },
        { ...pair(1, 0, 0), modA: modB, modB: modC, files: [file], bWins: 1 },
      ],
      totalPairs: 3,
      modsScanned: 3,
      missingDeps: [],
      modLoadOrder: ['A', 'B', 'C'],
    }

    const cStillWins = recalculateConflictWinners(result, ['B', 'A', 'C'])
    expect(cStillWins.pairs[0]).toMatchObject({ aWins: 0, bWins: 0, thirdPartyWins: 1, unknownWins: 0 })
    expect(cStillWins.pairs[0].files[0].winner?.modId).toBe('C')

    const aWins = recalculateConflictWinners(result, ['B', 'C', 'A'])
    expect(aWins.pairs[0]).toMatchObject({ aWins: 1, bWins: 0, thirdPartyWins: 0, unknownWins: 0 })
    expect(aWins.pairs[0].files[0].winner?.modId).toBe('A')
  })

  it('does not merge unrelated conflict groups that use the same file path', () => {
    const first = pair(1, 0, 0)
    first.files = [{ file: 'lua/shared/test.lua', category: 'lua-shared', severity: 'high' }]
    const second = {
      ...pair(1, 0, 0),
      modA: { workshopId: '3', modId: 'C', modName: 'C' },
      modB: { workshopId: '4', modId: 'D', modName: 'D' },
      files: [{ file: 'lua/shared/test.lua', category: 'lua-shared', severity: 'high' as const }],
    }
    const result = {
      totalConflicts: 2,
      identicalSkipped: 0,
      pairs: [first, second],
      totalPairs: 2,
      modsScanned: 4,
      missingDeps: [],
      modLoadOrder: ['A', 'B', 'C', 'D'],
    }

    const updated = recalculateConflictWinners(result, ['A', 'B', 'C', 'D'])
    expect(updated.pairs[0].files[0].winner?.modId).toBe('B')
    expect(updated.pairs[1].files[0].winner?.modId).toBe('D')
  })
})