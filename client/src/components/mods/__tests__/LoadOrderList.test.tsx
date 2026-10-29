import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ModGroup } from '@/lib/api'
import { buildGroupMembership, type GroupConflictSummary } from '@/lib/modGroupTools'
import { LoadOrderList, VIRTUALIZE_AT } from '../LoadOrderList'

// The Load order list with "Show groups": each group whose members sit
// together (or that is kept together) gets a header that moves the whole
// group, a group that is apart can be put together, and a long list renders
// only what is on screen.

Element.prototype.scrollIntoView = vi.fn()

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const STAMP = '2026-10-01T00:00:00.000Z'
const group = (id: string, name: string, modIds: string[], extra: Partial<ModGroup> = {}): ModGroup => ({
  id,
  name,
  description: '',
  modIds,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...extra,
})

interface HarnessProps {
  initial: string[]
  groups: ModGroup[]
  canManage?: boolean
  filter?: string
  showGroups?: boolean
  conflictsByGroup?: Map<string, GroupConflictSummary>
  onShowGroupConflicts?: (group: ModGroup, summary: GroupConflictSummary) => void
  onOrder?: (order: string[]) => void
}

function Harness({ initial, groups, canManage = true, filter = '', showGroups = true, conflictsByGroup, onShowGroupConflicts, onOrder }: HarnessProps) {
  const [order, setOrder] = useState(initial)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  return (
    <TooltipProvider>
      <LoadOrderList
        order={order}
        onOrderChange={(next) => {
          setOrder(next)
          onOrder?.(next)
        }}
        canManage={canManage}
        locked={false}
        filter={filter}
        modNames={new Map()}
        modWorkshop={new Map()}
        notes={{}}
        groups={groups}
        membership={buildGroupMembership(groups)}
        conflictsByGroup={conflictsByGroup}
        onShowGroupConflicts={onShowGroupConflicts}
        showGroups={showGroups}
        selected={selected}
        onSelectedChange={(modId, checked) =>
          setSelected((current) => {
            const next = new Set(current)
            if (checked) next.add(modId)
            else next.delete(modId)
            return next
          })
        }
      />
    </TooltipProvider>
  )
}

const shownOrder = () =>
  Array.from(document.querySelectorAll('[data-load-order-index]')).map((row) => row.querySelector('.font-mono')?.textContent)
const headers = () => Array.from(document.querySelectorAll('[data-block-header]')).map((el) => el.getAttribute('data-block-header'))
const status = () => document.querySelector('p[role="status"]')?.textContent

describe('LoadOrderList group blocks', () => {
  const VEHICLES = group('veh', 'Vehicles', ['Lib', 'Car', 'CarFix'])

  it('shows a header for a group whose members sit together, with its mod count', () => {
    render(<Harness initial={['A', 'Lib', 'Car', 'CarFix', 'B']} groups={[VEHICLES]} />)

    expect(headers()).toEqual(['veh'])
    const header = document.querySelector('[data-block-header="veh"]') as HTMLElement
    expect(header).toHaveTextContent('Vehicles')
    expect(header).toHaveTextContent('3 mods')
    expect(shownOrder()).toEqual(['A', 'Lib', 'Car', 'CarFix', 'B'])
  })

  it('moves the whole group with the block controls and announces it', () => {
    const onOrder = vi.fn()
    render(<Harness initial={['A', 'Lib', 'Car', 'CarFix', 'B']} groups={[VEHICLES]} onOrder={onOrder} />)

    fireEvent.click(screen.getByRole('button', { name: 'Move group Vehicles down' }))
    expect(shownOrder()).toEqual(['A', 'B', 'Lib', 'Car', 'CarFix'])
    expect(status()).toBe('Group Vehicles moved to position 3 of 5')

    fireEvent.click(screen.getByRole('button', { name: 'Move group Vehicles to the top' }))
    expect(shownOrder()).toEqual(['Lib', 'Car', 'CarFix', 'A', 'B'])
    expect(onOrder).toHaveBeenCalledTimes(2)
  })

  it('jumps over a neighbouring group block as a whole', () => {
    const maps = group('maps', 'Maps', ['M1', 'M2'])
    render(<Harness initial={['Lib', 'Car', 'CarFix', 'M1', 'M2']} groups={[VEHICLES, maps]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Move group Vehicles down' }))

    expect(shownOrder()).toEqual(['M1', 'M2', 'Lib', 'Car', 'CarFix'])
  })

  it('turns the edge controls off and says why', () => {
    render(<Harness initial={['Lib', 'Car', 'CarFix', 'A']} groups={[VEHICLES]} />)

    expect(screen.getByRole('button', { name: 'Move group Vehicles to the top' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move group Vehicles up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move group Vehicles down' })).toBeEnabled()
  })

  it('puts a kept-together group that is apart back together at its first member', () => {
    const together = group('veh', 'Vehicles', ['Lib', 'Car', 'CarFix'], { keepTogether: true })
    render(<Harness initial={['Lib', 'A', 'Car', 'B', 'CarFix']} groups={[together]} />)

    const header = document.querySelector('[data-block-header="veh"]') as HTMLElement
    expect(header).toHaveTextContent('Members are apart')
    expect(screen.queryByRole('button', { name: 'Move group Vehicles down' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Put together' }))

    expect(shownOrder()).toEqual(['Lib', 'Car', 'CarFix', 'A', 'B'])
    expect(status()).toBe('Vehicles put together')
  })

  it('gives a group that is apart and not kept together no header', () => {
    render(<Harness initial={['Lib', 'A', 'Car', 'CarFix']} groups={[VEHICLES]} />)
    expect(headers()).toEqual([])
  })

  it('collapses a block, and remembers it', () => {
    render(<Harness initial={['A', 'Lib', 'Car', 'CarFix']} groups={[VEHICLES]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse group Vehicles' }))

    expect(shownOrder()).toEqual(['A'])
    expect(screen.getByRole('button', { name: 'Expand group Vehicles' })).toHaveAttribute('aria-expanded', 'false')
    expect(JSON.parse(localStorage.getItem('zcp:mods:order:collapsedBlocks') ?? '[]')).toEqual(['veh'])

    cleanup()
    render(<Harness initial={['A', 'Lib', 'Car', 'CarFix']} groups={[VEHICLES]} />)
    expect(shownOrder()).toEqual(['A'])
  })

  it('opens the group conflicts from the header badge', () => {
    const summary: GroupConflictSummary = { internal: 1, external: 2, modIds: ['Car', 'CarFix', 'A'] }
    const onShow = vi.fn()
    render(
      <Harness initial={['A', 'Lib', 'Car', 'CarFix']} groups={[VEHICLES]} conflictsByGroup={new Map([['veh', summary]])} onShowGroupConflicts={onShow} />,
    )

    fireEvent.click(screen.getByRole('button', { name: '3 file conflicts involve Vehicles. Show them' }))

    expect(onShow).toHaveBeenCalledWith(VEHICLES, summary)
  })

  it('hides the headers while filtered, and shows plain rows without Show groups', () => {
    const { unmount } = render(<Harness initial={['A', 'Lib', 'Car', 'CarFix']} groups={[VEHICLES]} filter="car" />)
    expect(headers()).toEqual([])
    expect(shownOrder()).toEqual(['Car', 'CarFix'])
    unmount()

    render(<Harness initial={['A', 'Lib', 'Car', 'CarFix']} groups={[VEHICLES]} showGroups={false} />)
    expect(headers()).toEqual([])
    expect(shownOrder()).toEqual(['A', 'Lib', 'Car', 'CarFix'])
  })

  it('has no move controls or ticks without mods.manage', () => {
    render(<Harness initial={['A', 'Lib', 'Car', 'CarFix']} groups={[VEHICLES]} canManage={false} />)

    expect(screen.queryByRole('button', { name: 'Move group Vehicles down' })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Move A down' })).toBeNull()
  })
})

describe('LoadOrderList with a big list', () => {
  // jsdom lays nothing out: give the scroll box an 800px viewport and every
  // row its estimated height, so the virtualizer has a window to fill. The
  // virtualizer reads the scroll box through clientHeight, rows through
  // offsetHeight.
  beforeEach(() => {
    const height = function (this: HTMLElement) {
      return this.hasAttribute('data-load-order-scroll') ? 800 : 38
    }
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(height)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(height)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it(`renders only the rows on screen above ${VIRTUALIZE_AT} mods, and 600 mods render fast`, () => {
    const order = Array.from({ length: 600 }, (_, i) => `Mod${String(i).padStart(3, '0')}`)
    const groups = Array.from({ length: 30 }, (_, g) => group(`g${g}`, `Group ${g}`, order.slice(g * 20, g * 20 + 5)))

    const startedAt = performance.now()
    act(() => {
      render(<Harness initial={order} groups={groups} />)
    })
    const elapsed = performance.now() - startedAt

    const rendered = document.querySelectorAll('[data-load-order-index]').length
    expect(rendered).toBeGreaterThan(10)
    expect(rendered).toBeLessThan(100)
    expect(headers().length).toBeGreaterThan(0)
    // A generous ceiling for a loaded test machine.
    expect(elapsed).toBeLessThan(1500)
  })

  it('still moves a mod in a 600-mod list', () => {
    const order = Array.from({ length: 600 }, (_, i) => `Mod${String(i).padStart(3, '0')}`)
    const onOrder = vi.fn()
    render(<Harness initial={order} groups={[]} onOrder={onOrder} />)

    fireEvent.click(screen.getByRole('button', { name: 'Move Mod000 to the bottom' }))

    expect(onOrder.mock.calls[0][0].at(-1)).toBe('Mod000')
    expect(onOrder.mock.calls[0][0]).toHaveLength(600)
  })
})
