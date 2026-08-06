// Dependency-aware load-order sorting for the Mods > Load Order tab.
//
// Project Zomboid loads mods in the order they appear in `Mods=`. A mod that
// declares `require=` in its mod.info expects those mods to be loaded first.
// Alphabetical sorting would be actively harmful here, so this module only
// moves a mod when a declared dependency forces it, and otherwise preserves
// the order the user already arranged.

export interface AutoSortResult {
  /** The proposed load order. Same members as the input, only reordered. */
  order: string[]
  /** The minimal set of mods that had to be repositioned, 1-based before/after. */
  moved: Array<{ modId: string; from: number; to: number }>
  /** Dependency edges that were applied (dependency loads before dependent). */
  appliedEdges: number
  /**
   * Groups of mods that require each other. No order can satisfy a cycle, so
   * only the edges inside a group are dropped — every other constraint, including
   * the ones on mods downstream of the cycle, is still enforced.
   */
  cycles: string[][]
  /** Declared requirements that are not present in the load order at all. */
  missing: Array<{ modId: string; requires: string }>
}

/**
 * Resolve a declared `require=` entry against a set of mod IDs.
 *
 * An exact ID always wins. Otherwise a mod whose ID is `<required>_<suffix>` or
 * `<required>-<suffix>` satisfies it: that is the convention modders use when
 * they ship a refactor, test or legacy fork of the same mod from one workshop
 * item. When several forks match, the one earliest in the list wins so the
 * result is deterministic.
 *
 * Both the load-order sort and the missing-dependency report use this, so the
 * two can never disagree about whether a requirement is met.
 */
export function createRequirementResolver(
  modIds: Iterable<string>,
): (requirement: string) => string | null {
  const exact = new Set<string>()
  const lowerById: Array<[string, string]> = []
  for (const modId of modIds) {
    if (!modId || exact.has(modId)) continue
    exact.add(modId)
    lowerById.push([modId, modId.toLowerCase()])
  }

  const cache = new Map<string, string | null>()
  return (requirement: string): string | null => {
    const needle = requirement?.trim()
    if (!needle) return null
    const cached = cache.get(needle)
    if (cached !== undefined) return cached

    let resolved: string | null = null
    if (exact.has(needle)) {
      resolved = needle
    } else {
      const prefix = needle.toLowerCase()
      for (const [modId, lower] of lowerById) {
        if (lower.startsWith(prefix + '_') || lower.startsWith(prefix + '-')) {
          resolved = modId
          break
        }
      }
    }
    cache.set(needle, resolved)
    return resolved
  }
}

/**
 * Stable topological sort.
 *
 * Uses Kahn's algorithm, but always picks the ready node with the smallest
 * original index. That keeps the result as close to the user's existing order
 * as the dependency graph allows, so applying auto-sort twice is a no-op and
 * unrelated mods never shuffle around.
 */
export function computeAutoSortedOrder(
  modIds: string[],
  requiresByModId: Map<string, string[]>,
): AutoSortResult {
  // Deduplicate while keeping the first occurrence, so a malformed INI with a
  // repeated mod ID can't desynchronise the index bookkeeping below.
  const order: string[] = []
  const indexOf = new Map<string, number>()
  for (const modId of modIds) {
    if (indexOf.has(modId)) continue
    indexOf.set(modId, order.length)
    order.push(modId)
  }

  const resolve = createRequirementResolver(order)
  const indexOfMod = (modId: string) => indexOf.get(modId) ?? 0

  const dependents = new Map<string, string[]>()
  const missing: AutoSortResult['missing'] = []
  let appliedEdges = 0

  for (const modId of order) {
    const seenDependencies = new Set<string>()
    const reportedMissing = new Set<string>()
    for (const declared of requiresByModId.get(modId) || []) {
      const requirement = declared?.trim()
      if (!requirement) continue

      const dependency = resolve(requirement)
      if (!dependency) {
        // The dependency isn't enabled. Reporting it is useful, but it can't
        // constrain an order that doesn't contain it.
        if (reportedMissing.has(requirement)) continue
        reportedMissing.add(requirement)
        missing.push({ modId, requires: requirement })
        continue
      }

      // Self-requirement and duplicates carry no ordering information.
      if (dependency === modId || seenDependencies.has(dependency)) continue
      seenDependencies.add(dependency)

      const list = dependents.get(dependency)
      if (list) list.push(modId)
      else dependents.set(dependency, [modId])
      appliedEdges++
    }
  }

  // No order can satisfy a cycle, so drop the edges inside each one and keep
  // everything else. Appending the leftovers instead would also break the
  // perfectly satisfiable constraints of any mod that merely depends on a mod
  // caught in a cycle.
  const cycles = stronglyConnectedComponents(order, dependents)
    .filter((component) => component.length > 1)
    .map((component) => component.sort((a, b) => indexOfMod(a) - indexOfMod(b)))
    .sort((a, b) => indexOfMod(a[0]) - indexOfMod(b[0]))
  const cycleOf = new Map<string, number>()
  cycles.forEach((group, groupIndex) => {
    for (const modId of group) cycleOf.set(modId, groupIndex)
  })

  const remainingDeps = new Map<string, number>()
  for (const modId of order) remainingDeps.set(modId, 0)
  const unlocks = new Map<string, string[]>()
  for (const [dependency, list] of dependents) {
    for (const dependent of list) {
      const cycle = cycleOf.get(dependency)
      if (cycle !== undefined && cycle === cycleOf.get(dependent)) continue
      const existing = unlocks.get(dependency)
      if (existing) existing.push(dependent)
      else unlocks.set(dependency, [dependent])
      remainingDeps.set(dependent, (remainingDeps.get(dependent) ?? 0) + 1)
    }
  }

  // Ready set kept sorted by original index for deterministic, minimal movement.
  const ready = order.filter((modId) => (remainingDeps.get(modId) ?? 0) === 0)
  const byIndex = (a: string, b: string) => indexOfMod(a) - indexOfMod(b)
  ready.sort(byIndex)

  // With every intra-cycle edge removed the graph is acyclic, so this drains
  // completely and no mod can be dropped.
  const finalOrder: string[] = []
  while (ready.length > 0) {
    const modId = ready.shift() as string
    finalOrder.push(modId)

    let unlocked = false
    for (const dependent of unlocks.get(modId) || []) {
      const left = (remainingDeps.get(dependent) ?? 0) - 1
      remainingDeps.set(dependent, left)
      if (left === 0) {
        ready.push(dependent)
        unlocked = true
      }
    }
    if (unlocked) ready.sort(byIndex)
  }

  // Report only the mods that genuinely had to move. Everything that keeps its
  // relative position just drifts by an index or two when a mod above it moves,
  // and listing all of that noise would make the preview unreviewable.
  const originalIndices = finalOrder.map((modId) => indexOf.get(modId) as number)
  const stayed = longestIncreasingSubsequence(originalIndices)
  const moved: AutoSortResult['moved'] = []
  finalOrder.forEach((modId, index) => {
    if (stayed.has(index)) return
    moved.push({ modId, from: (indexOf.get(modId) as number) + 1, to: index + 1 })
  })

  return { order: finalOrder, moved, appliedEdges, cycles, missing }
}

/**
 * Indices of a longest increasing subsequence. Those entries can be considered
 * "in place"; the rest is the minimal set of items that had to be repositioned.
 */
function longestIncreasingSubsequence(values: number[]): Set<number> {
  const tails: number[] = [] // index in `values` of the smallest tail per length
  const previous = new Array<number>(values.length).fill(-1)

  for (let i = 0; i < values.length; i++) {
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (values[tails[mid]] < values[i]) low = mid + 1
      else high = mid
    }
    if (low > 0) previous[i] = tails[low - 1]
    tails[low] = i
  }

  const result = new Set<number>()
  let cursor = tails.length > 0 ? tails[tails.length - 1] : -1
  while (cursor !== -1) {
    result.add(cursor)
    cursor = previous[cursor]
  }
  return result
}

/**
 * Tarjan's strongly connected components, iterative so a long dependency chain
 * can't overflow the call stack. Every component of two or more nodes is a set
 * of mods that transitively require each other.
 */
function stronglyConnectedComponents(
  nodes: string[],
  edges: Map<string, string[]>,
): string[][] {
  const index = new Map<string, number>()
  const lowLink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  const visit = (node: string) => {
    index.set(node, counter)
    lowLink.set(node, counter)
    counter++
    stack.push(node)
    onStack.add(node)
  }

  for (const root of nodes) {
    if (index.has(root)) continue
    visit(root)
    // Each frame remembers how far through its successor list it got, which is
    // what the recursive version keeps on the call stack.
    const frames = [{ node: root, successors: edges.get(root) || [], cursor: 0 }]

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]

      if (frame.cursor < frame.successors.length) {
        const next = frame.successors[frame.cursor++]
        if (!index.has(next)) {
          visit(next)
          frames.push({ node: next, successors: edges.get(next) || [], cursor: 0 })
        } else if (onStack.has(next)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node) as number, index.get(next) as number))
        }
        continue
      }

      frames.pop()
      if (lowLink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = []
        for (;;) {
          const member = stack.pop() as string
          onStack.delete(member)
          component.push(member)
          if (member === frame.node) break
        }
        components.push(component)
      }

      const parent = frames[frames.length - 1]
      if (parent) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node) as number, lowLink.get(frame.node) as number))
      }
    }
  }

  return components
}

/**
 * Build the modId -> required modIds lookup from the INI workshop map that the
 * panel already loads for the Mods page.
 */
export function buildRequiresMap(
  workshopModMap: Record<string, Array<{ id: string; require?: string[] }>> | undefined,
): Map<string, string[]> {
  const requires = new Map<string, string[]>()
  for (const entries of Object.values(workshopModMap || {})) {
    for (const entry of entries) {
      if (!entry?.id || !entry.require?.length) continue
      const existing = requires.get(entry.id)
      if (existing) requires.set(entry.id, [...existing, ...entry.require])
      else requires.set(entry.id, [...entry.require])
    }
  }
  return requires
}
