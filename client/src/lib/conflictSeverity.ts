import type { ConflictModRef, ConflictPair, ConflictScanResult } from '@/types'

export type ConflictPairSeverity = 'high' | 'medium' | 'low'
export type ConflictPairSeverityFilter = 'all' | 'real' | ConflictPairSeverity

export function getConflictPairSeverity(pair: ConflictPair): ConflictPairSeverity {
  if (pair.highCount > 0) return 'high'
  if (pair.mediumCount > 0) return 'medium'
  return 'low'
}

export function matchesConflictPairSeverity(pair: ConflictPair, filter: ConflictPairSeverityFilter) {
  if (filter === 'all') return true
  const severity = getConflictPairSeverity(pair)
  return filter === 'real' ? severity !== 'low' : severity === filter
}

export function summarizeConflictPairSeverities(pairs: ConflictPair[]) {
  const counts = { all: pairs.length, real: 0, high: 0, medium: 0, low: 0 }
  for (const pair of pairs) {
    const severity = getConflictPairSeverity(pair)
    counts[severity]++
    if (severity !== 'low') counts.real++
  }
  return counts
}

export function createConflictScanSnapshot(workshopIds: string[] = [], modIds: string[] = []) {
  return JSON.stringify({
    ws: workshopIds.slice().sort(),
    mods: modIds,
  })
}

export function recalculateConflictWinners(result: ConflictScanResult, modLoadOrder: string[]): ConflictScanResult {
  const order = new Map(modLoadOrder.map((modId, index) => [modId, index]))
  const graphsByFile = new Map<string, { refs: Map<string, ConflictModRef>, edges: Map<string, Set<string>> }>()

  for (const pair of result.pairs) {
    for (const file of pair.files) {
      const key = `${file.category}\0${file.file}`
      const graph = graphsByFile.get(key) ?? { refs: new Map(), edges: new Map() }
      const candidates = [pair.modA, pair.modB, file.winner].filter((candidate): candidate is ConflictModRef => candidate != null)
      for (const candidate of candidates) {
        graph.refs.set(candidate.modId, candidate)
        if (!graph.edges.has(candidate.modId)) graph.edges.set(candidate.modId, new Set())
      }
      for (const candidate of candidates.slice(1)) {
        graph.edges.get(pair.modA.modId)!.add(candidate.modId)
        graph.edges.get(candidate.modId)!.add(pair.modA.modId)
      }
      graphsByFile.set(key, graph)
    }
  }

  const winnersByFileAndMod = new Map<string, ConflictModRef | null>()
  for (const [key, graph] of graphsByFile) {
    const visited = new Set<string>()
    for (const startModId of graph.refs.keys()) {
      if (visited.has(startModId)) continue
      const component: string[] = []
      const pending = [startModId]
      visited.add(startModId)
      while (pending.length > 0) {
        const modId = pending.pop()!
        component.push(modId)
        for (const adjacent of graph.edges.get(modId) ?? []) {
          if (!visited.has(adjacent)) {
            visited.add(adjacent)
            pending.push(adjacent)
          }
        }
      }
      let winner: ConflictModRef | null = null
      let winnerIndex = -1
      for (const modId of component) {
        const candidateIndex = order.get(modId)
        if (candidateIndex != null && candidateIndex > winnerIndex) {
          winner = graph.refs.get(modId) ?? null
          winnerIndex = candidateIndex
        }
      }
      for (const modId of component) winnersByFileAndMod.set(`${key}\0${modId}`, winner)
    }
  }

  return {
    ...result,
    modLoadOrder,
    pairs: result.pairs.map(pair => {
      let aWins = 0
      let bWins = 0
      let thirdPartyWins = 0
      let unknownWins = 0
      const files = pair.files.map(file => {
        const winner = winnersByFileAndMod.get(`${file.category}\0${file.file}\0${pair.modA.modId}`) ?? null
        if (!winner) unknownWins++
        else if (winner.modId === pair.modA.modId) aWins++
        else if (winner.modId === pair.modB.modId) bWins++
        else thirdPartyWins++
        return { ...file, winner }
      })
      return { ...pair, files, aWins, bWins, thirdPartyWins, unknownWins }
    }),
  }
}