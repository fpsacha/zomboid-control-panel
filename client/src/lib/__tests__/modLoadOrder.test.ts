import { describe, it, expect } from 'vitest'
import { buildRequiresMap, computeAutoSortedOrder, createRequirementResolver } from '../modLoadOrder'

const requires = (entries: Record<string, string[]>) => new Map(Object.entries(entries))

describe('computeAutoSortedOrder', () => {
  it('leaves an order untouched when no dependencies are declared', () => {
    const result = computeAutoSortedOrder(['B', 'A', 'C'], new Map())

    expect(result.order).toEqual(['B', 'A', 'C'])
    expect(result.moved).toEqual([])
    expect(result.appliedEdges).toBe(0)
  })

  it('moves a required library ahead of the mod that requires it', () => {
    const result = computeAutoSortedOrder(
      ['Overhaul', 'BaseLibrary'],
      requires({ Overhaul: ['BaseLibrary'] }),
    )

    expect(result.order).toEqual(['BaseLibrary', 'Overhaul'])
    expect(result.appliedEdges).toBe(1)
    // With only two mods either one can be called "the one that moved"; the
    // report describes the library being pulled above the mod requiring it.
    expect(result.moved).toEqual([{ modId: 'BaseLibrary', from: 2, to: 1 }])
  })

  it('only moves the dependent mod and keeps every other mod in relative order', () => {
    const result = computeAutoSortedOrder(
      ['Zed', 'Overhaul', 'Alpha', 'BaseLibrary'],
      requires({ Overhaul: ['BaseLibrary'] }),
    )

    // Zed / Alpha / BaseLibrary keep their relative order; only Overhaul is
    // pushed past the library it requires.
    expect(result.order).toEqual(['Zed', 'Alpha', 'BaseLibrary', 'Overhaul'])
    expect(result.moved).toEqual([{ modId: 'Overhaul', from: 2, to: 4 }])
  })

  it('does not report mods that merely drift when a mod above them moves', () => {
    // Only Overhaul is constrained. A, B and C shift down by one index each,
    // but none of them actually changed position relative to the others.
    const result = computeAutoSortedOrder(
      ['Overhaul', 'A', 'B', 'C', 'BaseLibrary'],
      requires({ Overhaul: ['BaseLibrary'] }),
    )

    expect(result.order).toEqual(['A', 'B', 'C', 'BaseLibrary', 'Overhaul'])
    expect(result.moved).toEqual([{ modId: 'Overhaul', from: 1, to: 5 }])
  })

  it('is idempotent', () => {
    const deps = requires({ Overhaul: ['BaseLibrary'], Patch: ['Overhaul'] })
    const first = computeAutoSortedOrder(['Patch', 'Overhaul', 'BaseLibrary'], deps)
    const second = computeAutoSortedOrder(first.order, deps)

    expect(second.order).toEqual(first.order)
    expect(second.moved).toEqual([])
  })

  it('reports requirements that are not in the load order', () => {
    const result = computeAutoSortedOrder(['Overhaul'], requires({ Overhaul: ['NotEnabled'] }))

    expect(result.order).toEqual(['Overhaul'])
    expect(result.missing).toEqual([{ modId: 'Overhaul', requires: 'NotEnabled' }])
  })

  it('keeps cyclic mods instead of dropping them, and reports them as one group', () => {
    const result = computeAutoSortedOrder(
      ['A', 'B', 'C'],
      requires({ A: ['B'], B: ['A'] }),
    )

    expect(result.order.slice().sort()).toEqual(['A', 'B', 'C'])
    expect(result.cycles).toEqual([['A', 'B']])
  })

  it('reports independent cycles separately instead of as one blob', () => {
    const result = computeAutoSortedOrder(
      ['A', 'B', 'C', 'D'],
      requires({ A: ['B'], B: ['A'], C: ['D'], D: ['C'] }),
    )

    expect(result.cycles).toEqual([['A', 'B'], ['C', 'D']])
  })

  it('still orders a mod that depends on a mod caught in a cycle', () => {
    // Patch -> A is perfectly satisfiable even though A and B require each
    // other, so Patch must still be moved below A.
    const result = computeAutoSortedOrder(
      ['Patch', 'A', 'B'],
      requires({ A: ['B'], B: ['A'], Patch: ['A'] }),
    )

    expect(result.order.indexOf('A')).toBeLessThan(result.order.indexOf('Patch'))
    expect(result.cycles).toEqual([['A', 'B']])
  })

  it('ignores self-requirements and duplicate entries', () => {
    const result = computeAutoSortedOrder(
      ['A', 'B'],
      requires({ A: ['A'], B: ['A', 'A'] }),
    )

    expect(result.order).toEqual(['A', 'B'])
    expect(result.appliedEdges).toBe(1)
  })

  it('orders against a fork that satisfies the requirement instead of calling it missing', () => {
    // The Conflicts tab already treats "BaseLibrary_Refactor" as satisfying
    // "require=BaseLibrary"; the sort has to agree and order against it.
    const result = computeAutoSortedOrder(
      ['Overhaul', 'BaseLibrary_Refactor'],
      requires({ Overhaul: ['BaseLibrary'] }),
    )

    expect(result.order).toEqual(['BaseLibrary_Refactor', 'Overhaul'])
    expect(result.appliedEdges).toBe(1)
    expect(result.missing).toEqual([])
  })

  it('trims padded requirement entries and reports each one once', () => {
    const result = computeAutoSortedOrder(
      ['Overhaul', 'BaseLibrary'],
      requires({ Overhaul: [' BaseLibrary ', '', '  ', 'NotEnabled', 'NotEnabled '] }),
    )

    expect(result.order).toEqual(['BaseLibrary', 'Overhaul'])
    expect(result.appliedEdges).toBe(1)
    expect(result.missing).toEqual([{ modId: 'Overhaul', requires: 'NotEnabled' }])
  })
})

describe('createRequirementResolver', () => {
  it('prefers an exact match over a fork', () => {
    const resolve = createRequirementResolver(['Base_Fork', 'Base'])

    expect(resolve('Base')).toBe('Base')
  })

  it('accepts underscore and dash forks case-insensitively', () => {
    const resolve = createRequirementResolver(['base_refactor', 'Other-Legacy'])

    expect(resolve('Base')).toBe('base_refactor')
    expect(resolve('other')).toBe('Other-Legacy')
  })

  it('does not treat an unrelated mod with a shared prefix as a fork', () => {
    const resolve = createRequirementResolver(['BaseLibraryExtra'])

    expect(resolve('BaseLibrary')).toBeNull()
  })

  it('returns null for blank requirements', () => {
    const resolve = createRequirementResolver(['A'])

    expect(resolve('   ')).toBeNull()
  })
})

describe('buildRequiresMap', () => {
  it('collects requirements from the workshop mod map', () => {
    const map = buildRequiresMap({
      '111': [{ id: 'Overhaul', require: ['BaseLibrary'] }, { id: 'NoDeps' }],
      '222': [{ id: 'BaseLibrary' }],
    })

    expect(map.get('Overhaul')).toEqual(['BaseLibrary'])
    expect(map.has('NoDeps')).toBe(false)
    expect(map.has('BaseLibrary')).toBe(false)
  })

  it('merges requirements when a mod ID appears under several workshop items', () => {
    const map = buildRequiresMap({
      '111': [{ id: 'Overhaul', require: ['A'] }],
      '222': [{ id: 'Overhaul', require: ['B'] }],
    })

    expect(map.get('Overhaul')).toEqual(['A', 'B'])
  })

  it('handles a missing workshop map', () => {
    expect(buildRequiresMap(undefined).size).toBe(0)
  })
})
